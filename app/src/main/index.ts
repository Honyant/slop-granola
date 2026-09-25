// App entry: lifecycle, windows, tray, and wiring of services to IPC.
import { app, BrowserWindow, dialog, Notification, session, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Events } from '@shared/ipc'
import { DEEP_LINK_SCHEME, parseDeepLink, type Route } from '@shared/routes'
import type { CalendarEvent } from '@shared/types'
import { AppContext } from './context'
import { keychainBox } from './secrets'
import { Db } from './db/database'
import { createNote, registerIpc, type Services } from './ipc'
import { installAppMenu } from './menu'
import { CalendarService } from './services/calendar'
import { ChatService } from './services/chat'
import { Dictation } from './services/dictation'
import { PromptController } from './services/prompts'
import { MicWatcher } from './audio/micWatcher'
import { Enhancer } from './services/enhance'
import { RecordingManager } from './services/recording'
import { TrayController } from './tray'
import { createMainWindow, OverlayWindow, PromptWindow } from './windows'
import { registerFontScheme, serveGranolaFonts } from './fonts'

const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000
const QUIT_FLUSH_TIMEOUT_MS = 8000
/** Matches the prompt card's slide-out animation (Prompt.module.css). */
const PROMPT_EXIT_MS = 300

// The data directory is pinned *before* renaming the app: `setName('Granola')`
// alone would make Electron use ~/Library/Application Support/Granola, which
// belongs to the real Granola app. Tests point at a throwaway profile instead.
app.setPath('userData', process.env.GRANOLA_USER_DATA ?? join(app.getPath('appData'), 'Granola Clone'))
app.setName('Granola')
registerFontScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  let mainWindow: BrowserWindow | null = null
  let overlay: OverlayWindow | null = null
  let pendingRoute: Route | null = null
  let quitting = false

  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const route = parseDeepLink(url)
    if (route) navigate(route)
  })
  app.on('second-instance', () => showMain())

  await app.whenReady()

  // The renderer never needs camera/mic/geolocation etc.; audio goes through the helper.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  const emit = <E extends keyof Events>(event: E, payload: Events[E]) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(event, payload)
    }
  }
  const db = new Db(join(app.getPath('userData'), 'granola.db'))
  const log = (message: string) => console.log(`[granola] ${message}`)
  serveGranolaFonts(log)
  const ctx = new AppContext(db, emit, log, keychainBox(log))
  seedSettings(ctx)
  ctx.notes.purgeTrash(Date.now() - TRASH_RETENTION_MS)
  ctx.chats.failInterrupted()

  const enhancer = new Enhancer(ctx, (noteId, title) => {
    const inFront = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused()
    if (inFront || !ctx.settings.get().notifications.notesReady || !Notification.isSupported()) return
    const notification = new Notification({ title: 'Your notes are ready', body: title })
    notification.on('click', () => navigate({ name: 'note', id: noteId }))
    notification.show()
  })
  const recording = new RecordingManager(ctx, (noteId) => {
    const settings = ctx.settings.get()
    if (settings.notes.autoEnhance && ctx.transcripts.list(noteId).length > 0) void enhancer.run(noteId)
  })
  const calendar = new CalendarService(ctx)
  const chat = new ChatService(ctx)

  function showMain(): BrowserWindow {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow()
      mainWindow.on('close', (event) => {
        // Closing the window keeps the app (and any recording) alive in the menu bar.
        if (!quitting) {
          event.preventDefault()
          mainWindow?.hide()
        }
      })
      mainWindow.on('focus', updateOverlay)
      mainWindow.on('blur', updateOverlay)
      mainWindow.on('hide', updateOverlay)
      mainWindow.on('show', updateOverlay)
      mainWindow.webContents.on('did-finish-load', () => {
        if (pendingRoute) mainWindow?.webContents.send('navigate', pendingRoute)
        pendingRoute = null
      })
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  function navigate(route: Route): void {
    const window = showMain()
    if (window.webContents.isLoading()) pendingRoute = route
    else window.webContents.send('navigate', route)
  }

  function updateOverlay(): void {
    const recordingNow = recording.activeNoteId !== null
    const mainInFront = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()
    if (!recordingNow || mainInFront) {
      overlay?.hide()
      return
    }
    overlay ??= new OverlayWindow()
    overlay.show()
  }
  recording.subscribe(() => updateOverlay())

  async function newNote(): Promise<void> {
    const note = createNote(services, {})
    navigate({ name: 'note', id: note.id })
    await startRecording(note.id)
  }

  async function openEvent(event: CalendarEvent, record: boolean): Promise<void> {
    const note = createNote(services, { event })
    navigate({ name: 'note', id: note.id })
    if (record) await startRecording(note.id)
  }

  /** Starts notes for a meeting without pulling the app over the call; the floating pill appears instead. */
  async function takeNotesQuietly(event: CalendarEvent | null): Promise<void> {
    const note = createNote(services, event ? { event } : {})
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigate', { name: 'note', id: note.id })
    await startRecording(note.id)
  }

  async function startRecording(noteId: string): Promise<void> {
    try {
      await recording.start(noteId)
    } catch (error) {
      ctx.log(`recording: ${(error as Error).message}`)
      // The note page shows the error inline; nothing else to do here.
    }
  }

  let promptWindow: PromptWindow | null = null
  let promptHideTimer: NodeJS.Timeout | null = null
  const prompts = new PromptController({
    settings: () => ctx.settings.get().notifications,
    upcomingEvents: () => calendar.upcomingEvents(),
    isRecording: () => recording.activeNoteId !== null,
    show: (prompt) => {
      emit('prompt:changed', prompt)
      if (promptHideTimer) clearTimeout(promptHideTimer)
      promptHideTimer = null
      if (prompt) (promptWindow ??= new PromptWindow()).show()
      // Let the card finish sliding out before the window disappears.
      else promptHideTimer = setTimeout(() => promptWindow?.hide(), PROMPT_EXIT_MS)
    },
    takeNotes: (event) => takeNotesQuietly(event),
    openUrl: (url) => void shell.openExternal(url),
    ignoreApp: (bundleId) => {
      const { ignoredApps } = ctx.settings.get().notifications
      ctx.settings.update({ notifications: { ignoredApps: [...new Set([...ignoredApps, bundleId])] } })
    },
    now: () => Date.now(),
  })
  recording.subscribe((state) => {
    if (state) prompts.onRecordingStarted()
  })
  const micWatcher = new MicWatcher((apps) => prompts.onMicApps(apps), ctx.log)
  micWatcher.start()
  const promptTicker = setInterval(() => prompts.tick(), 15_000)

  const services: Services = {
    ctx,
    recording,
    enhancer,
    chat,
    calendar,
    dictation: new Dictation(ctx, recording),
    prompts,
    resizePrompt: (height) => promptWindow?.resize(height),
    setOverlayExpanded: (expanded) => overlay?.setExpanded(expanded),
    focusMain: () => {
      const id = recording.activeNoteId
      if (id) navigate({ name: 'note', id })
      else showMain()
    },
  }
  registerIpc(services)

  installAppMenu({
    newNote: () => void newNote(),
    openSettings: () => navigate({ name: 'settings', section: 'preferences' }),
    toggleSidebar: () => emit('command', 'toggleSidebar'),
    search: () => {
      showMain()
      emit('command', 'search')
    },
  })

  // Packaged: icons ship as extraResources next to the asar. Dev: app/resources.
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const tray = new TrayController(resourcesDir, {
    openApp: () => showMain(),
    newNote: () => void newNote(),
    openEvent: (event) => void openEvent(event, false),
    joinEvent: (event) => {
      if (event.url) void shell.openExternal(event.url)
      void takeNotesQuietly(event)
    },
    openSettings: () => navigate({ name: 'settings', section: 'preferences' }),
    checkForUpdates: () => void dialog.showMessageBox({ message: 'Granola is up to date', detail: `Version ${app.getVersion()}` }),
    quit: () => app.quit(),
    quitAndStopRecording: () => app.quit(),
  })
  calendar.onUpcoming((events) => {
    tray.update(events, ctx.settings.get().calendar.showInMenuBar)
    prompts.tick()
  })
  calendar.start()

  app.on('activate', () => showMain())
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    if (!recording.activeNoteId) return
    // Give in-flight finals a moment to land so the end of the meeting is not lost.
    event.preventDefault()
    void Promise.race([recording.stop(), new Promise((r) => setTimeout(r, QUIT_FLUSH_TIMEOUT_MS))]).finally(() => app.quit())
  })
  app.on('will-quit', () => {
    tray.dispose()
    micWatcher.stop()
    clearInterval(promptTicker)
    calendar.dispose()
    db.close()
  })

  showMain()
}

/**
 * First run: take the name from the macOS account, and connection settings
 * from the environment when provided (GRANOLA_ASR_URL, GRANOLA_ASR_TOKEN,
 * GRANOLA_LLM_BASE_URL, GRANOLA_LLM_MODEL, GRANOLA_LLM_API_KEY). Never
 * overwrites values the user has set.
 */
function seedSettings(ctx: AppContext): void {
  const s = ctx.settings.get()
  const env = process.env
  const name = s.profile.name || accountFullName()
  ctx.settings.update({
    profile: { name },
    workspace: { name: s.workspace.name || `${name.split(' ')[0]} HQ` },
    transcription: {
      url: s.transcription.url || env.GRANOLA_ASR_URL || '',
      token: s.transcription.token || env.GRANOLA_ASR_TOKEN || '',
    },
    llm: {
      baseUrl: s.llm.baseUrl || env.GRANOLA_LLM_BASE_URL || '',
      model: s.llm.model || env.GRANOLA_LLM_MODEL || '',
      apiKey: s.llm.apiKey || env.GRANOLA_LLM_API_KEY || env.GRANOLA_ASR_TOKEN || '',
    },
  })
}

function accountFullName(): string {
  try {
    return execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim() || userInfo().username
  } catch {
    return userInfo().username
  }
}

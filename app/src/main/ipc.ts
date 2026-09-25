// Main-process implementation of the IPC contract in shared/ipc.ts.
import { readFile } from 'node:fs/promises'
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { channel, type Api, type Implementation } from '@shared/ipc'
import { noteLink } from '@shared/routes'
import type { CalendarEvent, InputDevice, Note, Permissions } from '@shared/types'
import type { AppContext } from './context'
import { runHelper } from './audio/helper'
import { eventKey } from './db/notes'
import { complete, llmConfig } from './llm/client'
import { testTranscription } from './transcription/providers'
import { importGranolaExport } from './services/granolaImport'
import type { CalendarService } from './services/calendar'
import type { ChatService } from './services/chat'
import type { PromptController } from './services/prompts'
import type { Dictation } from './services/dictation'
import type { Enhancer } from './services/enhance'
import type { RecordingManager } from './services/recording'

export interface Services {
  ctx: AppContext
  recording: RecordingManager
  enhancer: Enhancer
  chat: ChatService
  calendar: CalendarService
  dictation: Dictation
  prompts: PromptController
  resizePrompt(height: number): void
  setOverlayExpanded(expanded: boolean): void
  focusMain(): void
}

const PRIVACY_PANES: Record<keyof Permissions, string> = {
  microphone: 'Privacy_Microphone',
  calendar: 'Privacy_Calendars',
  systemAudio: 'Privacy_AudioCapture',
}

export function createNote(services: Services, input: { event?: CalendarEvent; folderId?: string }): Note {
  const { ctx } = services
  const { event, folderId } = input
  if (event) {
    const existing = ctx.notes.findByEvent(eventKey(event.id, event.start))
    if (existing) {
      if (folderId) ctx.notes.setFolder([existing], folderId, true)
      return ctx.notes.get(existing)!
    }
  }
  const self = ctx.self()
  const attendees = event?.attendees.length ? event.attendees : [self]
  const id = ctx.notes.create({
    title: event?.title ?? '',
    meetingAt: event ? Date.parse(event.start) : Date.now(),
    event: event
      ? {
          id: event.id,
          calendarId: event.calendarId,
          title: event.title,
          start: event.start,
          end: event.end,
          location: event.location,
          url: event.url,
        }
      : null,
    // The calendar may not list the organiser's own address; the user is always present.
    attendees: attendees.some((a) => a.isSelf) ? attendees : [self, ...attendees],
    ...(folderId ? { folderId } : {}),
    templateId: null,
  })
  ctx.emit('notes:changed', { ids: [id] })
  return ctx.notes.get(id)!
}

export function registerIpc(services: Services): void {
  const { ctx, recording, enhancer, chat, calendar } = services

  const withRecording = <T extends { id: string; isRecording: boolean }>(note: T): T => ({
    ...note,
    isRecording: recording.activeNoteId === note.id,
  })

  const api: Implementation<Api> = {
    notes: {
      importGranola: async () => {
        const choice = await dialog.showOpenDialog({
          title: 'Import from Granola',
          properties: ['openFile'],
          filters: [{ name: 'Granola transcript export', extensions: ['txt', 'md'] }],
        })
        const path = choice.canceled ? undefined : choice.filePaths[0]
        if (!path) return null
        const result = importGranolaExport(ctx, await readFile(path, 'utf8'))
        ctx.log(`import: ${result.imported.length} meetings imported, ${result.skipped.length} already present, from ${path}`)
        ctx.emit('notes:changed', { ids: 'all' })
        return { imported: result.imported.length, skipped: result.skipped.length }
      },
      list: () => ctx.notes.list().map(withRecording),
      listInFolder: (folderId) => ctx.notes.listInFolder(folderId).map(withRecording),
      get: (id) => {
        const note = ctx.notes.get(id)
        return note && note.trashedAt === null ? withRecording(note) : null
      },
      create: (input) => withRecording(createNote(services, input)),
      update: (id, patch) => {
        ctx.notes.update(id, patch)
        ctx.emit('notes:changed', { ids: [id] })
      },
      trash: async (ids) => {
        if (recording.activeNoteId && ids.includes(recording.activeNoteId)) await recording.stop()
        ctx.notes.trash(ids)
        ctx.emit('notes:changed', { ids })
        ctx.emit('folders:changed', null)
      },
      setFolder: (noteIds, folderId, member) => {
        ctx.notes.setFolder(noteIds, folderId, member)
        ctx.emit('notes:changed', { ids: noteIds })
        ctx.emit('folders:changed', null)
      },
      transcript: (id) => ctx.transcripts.list(id),
      enhance: (id) => void enhancer.run(id),
      copyLink: (id) => {
        const link = noteLink(id)
        clipboard.writeText(link)
        return link
      },
      search: (query) => ctx.search.search(query),
      stats: () => ctx.stats.usage(),
    },
    folders: {
      list: () => ctx.folders.list(),
      create: (name) => {
        const folder = ctx.folders.create(name)
        ctx.emit('folders:changed', null)
        return folder
      },
      rename: (id, name) => {
        ctx.folders.rename(id, name)
        ctx.emit('folders:changed', null)
      },
      remove: (id) => {
        ctx.folders.remove(id)
        ctx.emit('folders:changed', null)
        ctx.emit('notes:changed', { ids: 'all' })
      },
    },
    people: {
      list: () => ctx.people.list(),
      companies: () => ctx.people.companies(),
    },
    recording: {
      start: async (noteId) => {
        await recording.start(noteId)
        ctx.emit('notes:changed', { ids: [noteId] })
      },
      stop: () => recording.stop(),
      setPaused: (paused) => recording.setPaused(paused),
      state: () => recording.state(),
      setMicDevice: (uid) => recording.setMic(uid),
    },
    audio: {
      devices: async () =>
        (await runHelper<{ inputs: { uid: string; name: string; is_default: boolean }[] }>(['devices'])).inputs.map((d): InputDevice => ({
          uid: d.uid,
          name: d.name,
          isDefault: d.is_default,
        })),
    },
    dictation: {
      start: () => services.dictation.start(),
      stop: () => services.dictation.stop(),
    },
    calendar: {
      calendars: () => calendar.calendars(),
      events: (from, to) => calendar.events(from, to),
    },
    chat: {
      send: (input) => chat.send(input),
      thread: (id) => ctx.chats.thread(id),
      threads: () => ctx.chats.threads(),
      cancel: (messageId) => chat.cancel(messageId),
    },
    recipes: { list: () => ctx.catalog.recipes() },
    templates: { list: () => ctx.catalog.templates() },
    settings: {
      get: () => ctx.settings.get(),
      update: (patch) => {
        const next = ctx.settings.update(patch)
        ctx.emit('settings:changed', next)
        if (patch.calendar) void calendar.refresh()
        return next
      },
      testTranscription: () => testTranscription(ctx.settings.get()),
      testLlm: async () => {
        try {
          const reply = await complete(
            llmConfig(ctx.settings.get()),
            [{ role: 'user', content: 'Reply with the single word: ready' }],
            AbortSignal.timeout(60_000),
          )
          return { ok: true, detail: `Connected · replied "${reply.trim().slice(0, 40)}"` }
        } catch (error) {
          return { ok: false, detail: (error as Error).message }
        }
      },
    },
    system: {
      permissions: () => permissions([]),
      requestPermission: (kind) => permissions(['--request', kind === 'systemAudio' ? 'system_audio' : kind]),
      openExternal: (url) => {
        if (/^(https?:|mailto:)/.test(url)) void shell.openExternal(url)
      },
      copy: (text) => clipboard.writeText(text),
      chooseFile: async (title, extensions) => {
        const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: title, extensions }] })
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      openPrivacySettings: (kind) =>
        void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[kind]}`),
      version: () => app.getVersion(),
    },
    overlay: {
      setExpanded: (expanded) => services.setOverlayExpanded(expanded),
      focusMain: () => services.focusMain(),
    },
    prompt: {
      current: () => services.prompts.prompt,
      act: (id, action) => services.prompts.act(id, action),
      resize: (height) => services.resizePrompt(height),
    },
  }

  for (const [namespace, methods] of Object.entries(api)) {
    for (const [method, fn] of Object.entries(methods as Record<string, (...args: unknown[]) => unknown>)) {
      ipcMain.handle(channel(namespace, method), (_event, ...args: unknown[]) => fn(...args))
    }
  }
}

async function permissions(args: string[]): Promise<Permissions> {
  try {
    const raw = await runHelper<{ microphone: string; calendar: string; system_audio: string }>(['permissions', ...args], 120_000)
    return { microphone: raw.microphone, calendar: raw.calendar, systemAudio: raw.system_audio } as Permissions
  } catch {
    return { microphone: 'unknown', calendar: 'unknown', systemAudio: 'unknown' }
  }
}

import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'

const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')

const secureWebPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: true,
}

function load(window: BrowserWindow, page: 'index' | 'overlay' | 'prompt'): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) void window.loadURL(`${devServer}/${page}.html`)
  else void window.loadFile(join(import.meta.dirname, `../renderer/${page}.html`))
}

/** Keeps every window on our own pages; links open in the default browser. */
function lockNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
}

export function createMainWindow(): BrowserWindow {
  // 1198×838 is the default window size in the reference screenshots.
  const window = new BrowserWindow({
    width: 1198,
    height: 838,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Granola',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: '#292929',
    webPreferences: secureWebPreferences,
  })
  lockNavigation(window)
  window.once('ready-to-show', () => window.show())
  load(window, 'index')
  return window
}

/**
 * A floating, non-activating panel pinned near the top-right of the screen.
 * Clicking it does not take focus away from the call the user is in.
 */
function createPanel(page: 'overlay' | 'prompt', size: { width: number; height: number }): BrowserWindow {
  const window = new BrowserWindow({
    ...size,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    type: 'panel',
    webPreferences: secureWebPreferences,
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  lockNavigation(window)
  load(window, page)
  return window
}

/** Top-right corner of the work area of the display the cursor is on. */
function topRight(): { right: number; top: number } {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return { right: workArea.x + workArea.width - 12, top: workArea.y + 8 }
}

/**
 * Floating transcript pill shown while recording when the main window is not
 * in front (Granola's "nub"). Expanding grows it leftwards from its right edge.
 * If the user drags it somewhere, it stays there for the rest of the session.
 */
export class OverlayWindow {
  static readonly COLLAPSED = { width: 64, height: 96 }
  static readonly EXPANDED = { width: 372, height: 380 }
  readonly window: BrowserWindow
  private expanded = false
  /** Right edge and top chosen by dragging; null = default corner. */
  private anchor: { right: number; top: number } | null = null
  private userMoving = false

  constructor() {
    this.window = createPanel('overlay', OverlayWindow.COLLAPSED)
    // 'will-move' fires only for moves the user makes, never for our own setBounds.
    this.window.on('will-move', () => {
      this.userMoving = true
    })
    this.window.on('moved', () => {
      if (!this.userMoving) return
      this.userMoving = false
      const b = this.window.getBounds()
      this.anchor = { right: b.x + b.width, top: b.y }
    })
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.place()
  }

  show(): void {
    this.place()
    if (!this.window.isVisible()) this.window.showInactive()
  }

  hide(): void {
    if (this.window.isVisible()) this.window.hide()
    this.expanded = false
  }

  private place(): void {
    const size = this.expanded ? OverlayWindow.EXPANDED : OverlayWindow.COLLAPSED
    const { right, top } = this.anchor ?? topRight()
    this.window.setBounds({ x: Math.round(right - size.width), y: Math.round(top), ...size })
  }
}

/** The "Meeting detected" / "Join meeting" prompt. Sized by its content. */
export class PromptWindow {
  static readonly WIDTH = 412
  readonly window: BrowserWindow
  private height = 72

  constructor() {
    this.window = createPanel('prompt', { width: PromptWindow.WIDTH, height: this.height })
  }

  show(): void {
    this.place()
    if (!this.window.isVisible()) this.window.showInactive()
  }

  hide(): void {
    if (this.window.isVisible()) this.window.hide()
  }

  resize(height: number): void {
    this.height = Math.max(40, Math.min(400, Math.round(height)))
    if (this.window.isVisible()) this.place()
  }

  private place(): void {
    const { right, top } = topRight()
    this.window.setBounds({ x: right - PromptWindow.WIDTH, y: top, width: PromptWindow.WIDTH, height: this.height })
  }
}

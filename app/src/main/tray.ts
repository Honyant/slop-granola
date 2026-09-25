// Menu-bar item: countdown for the current/next meeting and a menu of what is
// on now, later today and tomorrow (mirrors Granola's status item).
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { join } from 'node:path'
import { platformOf, type Platform } from '@shared/meetings'
import { addDays, startOfDay, trayTitle } from '@shared/time'
import type { CalendarEvent } from '@shared/types'

export interface TrayActions {
  openApp(): void
  newNote(): void
  /** Opens the event's note. */
  openEvent(event: CalendarEvent): void
  /** Opens the meeting link and starts taking notes. */
  joinEvent(event: CalendarEvent): void
  openSettings(): void
  checkForUpdates(): void
  quit(): void
  quitAndStopRecording(): void
}

const TICK_MS = 15_000
/** Clicking a linked meeting joins it from this long before its start until it ends. */
const JOINABLE_LEAD_MS = 10 * 60_000
const PLATFORMS: Platform[] = ['zoom', 'meet', 'teams', 'webex', 'other']

export class TrayController {
  private readonly tray: Tray
  private readonly icons: Record<Platform, NativeImage>
  private events: CalendarEvent[] = []
  private showTitle = true
  private readonly timer: NodeJS.Timeout

  constructor(
    resourcesDir: string,
    private readonly actions: TrayActions,
  ) {
    const icon = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate.png'))
    icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Granola')
    this.icons = Object.fromEntries(
      PLATFORMS.map((p) => [p, nativeImage.createFromPath(join(resourcesDir, `meeting-${p}.png`))]),
    ) as Record<Platform, NativeImage>
    this.timer = setInterval(() => this.render(), TICK_MS)
    this.render()
  }

  update(events: CalendarEvent[], showTitle: boolean): void {
    this.events = events
    this.showTitle = showTitle
    this.render()
  }

  dispose(): void {
    clearInterval(this.timer)
    this.tray.destroy()
  }

  private render(now = Date.now()): void {
    const live = this.events.filter((e) => Date.parse(e.end) > now)
    this.tray.setTitle(this.showTitle ? trayTitle(live, now) : '', { fontType: 'monospacedDigit' })
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(live, now)))
  }

  private menu(events: CalendarEvent[], now: number): MenuItemConstructorOptions[] {
    const item = (e: CalendarEvent): MenuItemConstructorOptions => {
      const platform = platformOf(e.url)
      const joinable = platform !== null && Date.parse(e.start) - JOINABLE_LEAD_MS <= now
      return {
        label: e.title,
        sublabel: [range(e), e.location].filter(Boolean).join(' · '),
        ...(platform ? { icon: this.icons[platform] } : {}),
        click: () => (joinable ? this.actions.joinEvent(e) : this.actions.openEvent(e)),
      }
    }
    const tomorrow = addDays(startOfDay(now), 1)
    const sections: [string, CalendarEvent[]][] = [
      ['Now', events.filter((e) => Date.parse(e.start) <= now)],
      ['Today', events.filter((e) => Date.parse(e.start) > now && Date.parse(e.start) < tomorrow)],
      ['Tomorrow', events.filter((e) => Date.parse(e.start) >= tomorrow)],
    ]

    const template: MenuItemConstructorOptions[] = []
    for (const [heading, list] of sections) {
      if (list.length === 0) continue
      template.push({ label: heading, enabled: false }, ...list.map(item), { type: 'separator' })
    }
    template.push(
      { label: 'Open Granola', click: () => this.actions.openApp() },
      { label: 'New Note', click: () => this.actions.newNote() },
      { label: 'Settings', click: () => this.actions.openSettings() },
      { label: `Granola v${app.getVersion()}`, enabled: false },
      { label: 'Latest version', enabled: false },
      { label: 'Check for updates', click: () => this.actions.checkForUpdates() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.actions.quit() },
      {
        label: 'Quit Options',
        submenu: [
          { label: 'Quit and stop recording', click: () => this.actions.quitAndStopRecording() },
          { label: 'Quit', click: () => this.actions.quit() },
        ],
      },
    )
    return template
  }
}

function range(e: CalendarEvent): string {
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${fmt(e.start)} - ${fmt(e.end)}`
}

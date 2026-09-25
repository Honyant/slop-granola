// Decides when to show the top-right meeting prompt:
//  - "Meeting detected": another app started using the microphone (Zoom, a Meet tab...).
//  - "Upcoming": a calendar meeting with a join link is about to start.
// Pure policy lives here; the window and the actions are injected.
import { randomUUID } from 'node:crypto'
import { eventForCall, joinableNow } from '@shared/meetings'
import type { CalendarEvent, MeetingPrompt, PromptAction } from '@shared/types'
import type { MicApp } from '../audio/micWatcher'

/** After a prompt for an app is dismissed or ignored, stay quiet about that app this long. */
const DETECT_COOLDOWN_MS = 10 * 60_000

export interface PromptDeps {
  settings(): { meetingDetected: boolean; meetingStart: boolean; ignoredApps: string[] }
  upcomingEvents(): CalendarEvent[]
  isRecording(): boolean
  show(prompt: MeetingPrompt | null): void
  /** Opens (or creates) the note for the event, or a new note, and starts transcribing. */
  takeNotes(event: CalendarEvent | null): Promise<void>
  openUrl(url: string): void
  ignoreApp(bundleId: string): void
  now(): number
}

export class PromptController {
  private current: MeetingPrompt | null = null
  private micApps: MicApp[] = []
  private readonly quietUntil = new Map<string, number>()
  private readonly promptedEvents = new Set<string>()

  constructor(private readonly deps: PromptDeps) {}

  get prompt(): MeetingPrompt | null {
    return this.current
  }

  onMicApps(apps: MicApp[]): void {
    const before = new Set(this.micApps.map((a) => a.pid))
    this.micApps = apps
    // The app that triggered the prompt stopped using the mic: the call is over.
    const current = this.current
    if (current?.kind === 'detected' && !apps.some((a) => a.name === current.appName)) this.set(null)
    const arrived = apps.find((a) => !before.has(a.pid))
    if (arrived) this.detect(arrived)
  }

  /** Called periodically and whenever the calendar changes. */
  tick(): void {
    // A call detected before the calendar had loaded gets its event once it has.
    const current = this.current
    if (current?.kind === 'detected' && !current.event) {
      const event = this.eventFor(current.bundleId)
      if (event) this.set({ ...current, event })
    }
    const { meetingStart } = this.deps.settings()
    if (!meetingStart || this.deps.isRecording() || this.current) return
    const event = joinableNow(this.deps.upcomingEvents(), this.deps.now()).find((e) => !this.promptedEvents.has(eventKey(e)))
    if (!event) return
    this.promptedEvents.add(eventKey(event))
    this.set({ id: randomUUID(), kind: 'upcoming', event })
  }

  async act(id: string, action: PromptAction): Promise<void> {
    const prompt = this.current
    if (!prompt || prompt.id !== id) return
    this.set(null)
    const key = prompt.kind === 'detected' ? appKey(prompt) : null
    const event = prompt.event ?? (prompt.kind === 'detected' ? this.eventFor(prompt.bundleId) : null)
    switch (action) {
      case 'join':
        if (event?.url) this.deps.openUrl(event.url)
        await this.deps.takeNotes(event)
        return
      case 'take-notes':
        await this.deps.takeNotes(event)
        return
      case 'ignore-app':
        if (prompt.kind === 'detected' && prompt.bundleId) this.deps.ignoreApp(prompt.bundleId)
        return
      case 'dismiss':
      case 'expire':
        if (key) this.quietUntil.set(key, this.deps.now() + DETECT_COOLDOWN_MS)
        return
    }
  }

  /** Recording started from anywhere: a pending prompt is moot. */
  onRecordingStarted(): void {
    this.set(null)
  }

  private detect(app: MicApp): void {
    const { meetingDetected, ignoredApps } = this.deps.settings()
    const key = app.bundleId ?? app.name
    if (!meetingDetected || this.deps.isRecording()) return
    if (app.bundleId && ignoredApps.includes(app.bundleId)) return
    if ((this.quietUntil.get(key) ?? 0) > this.deps.now()) return
    const event = this.eventFor(app.bundleId)
    // Being in the call supersedes the invitation to join it.
    if (event) this.promptedEvents.add(eventKey(event))
    this.set({ id: randomUUID(), kind: 'detected', appName: app.name, bundleId: app.bundleId, event })
  }

  private eventFor(bundleId: string | null): CalendarEvent | null {
    return eventForCall(this.deps.upcomingEvents(), bundleId, this.deps.now())
  }

  private set(prompt: MeetingPrompt | null): void {
    this.current = prompt
    this.deps.show(prompt)
  }
}

const eventKey = (e: CalendarEvent) => `${e.id}|${e.start}`
const appKey = (p: { bundleId: string | null; appName: string }) => p.bundleId ?? p.appName

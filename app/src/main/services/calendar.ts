// Calendar events from macOS EventKit (through granola-helper).
//
// Why EventKit rather than the Google Calendar API: it already aggregates every
// account the user added to macOS (Google, iCloud, Exchange), needs no OAuth
// client or tokens, and works offline.
import { defaultVisibleCalendars } from '@shared/calendar'
import type { CalendarEvent, CalendarInfo } from '@shared/types'
import type { AppContext } from '../context'
import { HelperError, runHelper } from '../audio/helper'

interface HelperParticipant {
  name: string | null
  email: string | null
  status: string
  is_self: boolean
}

interface HelperCalendar {
  id: string
  title: string
  color: string
  source: string
  is_default?: boolean
}

interface HelperEvent {
  id: string
  calendar_id: string
  title: string
  start: string
  end: string
  all_day: boolean
  location: string | null
  url: string | null
  notes: string | null
  attendees: HelperParticipant[]
}

const POLL_MS = 60_000
const CALENDAR_LIST_TTL_MS = 5 * 60_000
const MEETING_LINK =
  /https:\/\/(?:[\w-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|around\.co)\/\S+/i

export class CalendarService {
  private calendarsCache: { at: number; value: CalendarInfo[] } | null = null
  private upcoming: CalendarEvent[] = []
  private upcomingSignature = ''
  private timer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<(events: CalendarEvent[]) => void>()

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Events from now until the end of tomorrow, as last polled. */
  upcomingEvents(): CalendarEvent[] {
    return this.upcoming
  }

  onUpcoming(listener: (events: CalendarEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async calendars(): Promise<CalendarInfo[]> {
    if (this.calendarsCache && Date.now() - this.calendarsCache.at < CALENDAR_LIST_TTL_MS) {
      return this.calendarsCache.value
    }
    try {
      const raw = await runHelper<{ calendars: HelperCalendar[] }>(['calendar', 'list'])
      const calendars = raw.calendars.map((c) => ({
        id: c.id,
        title: c.title,
        color: c.color,
        source: c.source,
        isDefault: c.is_default ?? false,
      }))
      this.calendarsCache = { at: Date.now(), value: calendars }
      return calendars
    } catch (error) {
      this.logFailure(error)
      return []
    }
  }

  async events(fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const settings = this.ctx.settings.get().calendar
    const calendars = await this.calendars()
    const visible = settings.visibleCalendarIds ?? defaultVisibleCalendars(calendars)
    if (visible.length === 0) return []
    const colors = new Map(calendars.map((c) => [c.id, c.color]))
    let raw: HelperEvent[]
    try {
      raw = (
        await runHelper<{ events: HelperEvent[] }>([
          'calendar',
          'events',
          '--from',
          fromIso,
          '--to',
          toIso,
          '--calendars',
          visible.join(','),
        ])
      ).events
    } catch (error) {
      this.logFailure(error)
      return []
    }
    return raw
      .filter((e) => !e.all_day)
      .map((e) => toEvent(e, colors.get(e.calendar_id) ?? '#a191ce'))
      .filter((e) => settings.showEventsWithoutParticipants || hasOtherParticipants(e))
      .sort((a, b) => a.start.localeCompare(b.start))
  }

  /** Invalidates caches after settings that affect visibility change. */
  async refresh(): Promise<void> {
    this.calendarsCache = null
    const now = new Date()
    const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)
    const events = (await this.events(now.toISOString(), endOfTomorrow.toISOString())).filter((e) => Date.parse(e.end) > now.getTime())
    const signature = JSON.stringify(events.map((e) => [e.id, e.start, e.end, e.title]))
    this.upcoming = events
    if (signature !== this.upcomingSignature) {
      this.upcomingSignature = signature
      this.ctx.emit('calendar:changed', null)
    }
    for (const listener of this.listeners) listener(events)
  }

  private logFailure(error: unknown): void {
    const code = error instanceof HelperError ? error.code : 'error'
    this.ctx.log(`calendar: ${code}: ${(error as Error).message}`)
  }
}

function toEvent(e: HelperEvent, color: string): CalendarEvent {
  const url = e.url ?? [e.location, e.notes].map((text) => text?.match(MEETING_LINK)?.[0]).find(Boolean) ?? null
  return {
    id: e.id,
    calendarId: e.calendar_id,
    title: e.title || 'Untitled event',
    start: e.start,
    end: e.end,
    allDay: e.all_day,
    location: e.location,
    url,
    color,
    attendees: e.attendees
      .filter((p) => p.email || p.name)
      .map((p) => ({ name: p.name || p.email!.split('@')[0]!, email: p.email?.toLowerCase() ?? null, isSelf: p.is_self })),
  }
}

function hasOtherParticipants(e: CalendarEvent): boolean {
  return e.url !== null || e.attendees.some((a) => !a.isSelf)
}

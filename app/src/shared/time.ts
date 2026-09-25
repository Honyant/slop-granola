// Date/time formatting shared by the tray (main) and the UI (renderer).
// All functions take `now` explicitly so they are deterministic under test.

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** "1h 58m", "12m", "45s" — for countdowns. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(ms, 0) / MINUTE)
  if (totalMinutes === 0) return `${Math.max(0, Math.floor(ms / 1000))}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours === 0 ? `${minutes}m` : minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function addDays(ms: number, days: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

/** "4:15", with the meridiem returned separately so the UI can style it smaller. */
export function clock(ms: number): { time: string; meridiem: 'AM' | 'PM' } {
  const d = new Date(ms)
  const h = d.getHours()
  return {
    time: `${h % 12 || 12}:${d.getMinutes().toString().padStart(2, '0')}`,
    meridiem: h < 12 ? 'AM' : 'PM',
  }
}

/** "4:15 – 6:45 PM" or "11:30 AM – 12:15 PM" (meridiem shown once when shared). */
export function timeRange(startMs: number, endMs: number): string {
  const a = clock(startMs)
  const b = clock(endMs)
  return a.meridiem === b.meridiem ? `${a.time} – ${b.time} ${b.meridiem}` : `${a.time} ${a.meridiem} – ${b.time} ${b.meridiem}`
}

/** Heading for a group of notes: "Today", "Yesterday", "Tue, Sep 22", or with year when not this year. */
export function dayHeading(ms: number, now: number): string {
  const day = startOfDay(ms)
  const today = startOfDay(now)
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Relative day for tables: "Today", "Yesterday", weekday within a week, else "Sep 9" / "Sep 9, 2024". */
export function relativeDay(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(ms)
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export interface TimedEvent {
  title: string
  start: string
  end: string
}

/** A meeting that started less than this long ago reads "now" rather than "Xm left". */
const JUST_STARTED_MS = 2 * MINUTE
/** Longer titles are clipped to 12 characters plus an ellipsis, as Granola's status item does. */
const TITLE_LIMIT = 15

/**
 * Menu-bar title: the current meeting ("now" while it is just starting, then the
 * time left), else the next one within 12 hours with time until it starts, else
 * nothing. Titles are clipped ("https://meet... • now").
 */
export function trayTitle(events: readonly TimedEvent[], now: number): string {
  const clip = (title: string) => (title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 3)}...` : title)
  const current = events.find((e) => Date.parse(e.start) <= now && now < Date.parse(e.end))
  if (current) {
    const started = now - Date.parse(current.start)
    return started < JUST_STARTED_MS
      ? `${clip(current.title)} • now`
      : `${clip(current.title)} • ${formatDuration(Date.parse(current.end) - now)} left`
  }
  const next = events.find((e) => Date.parse(e.start) > now && Date.parse(e.start) < addDays(now, 1))
  if (next && Date.parse(next.start) - now <= 12 * HOUR) return `${clip(next.title)} • in ${formatDuration(Date.parse(next.start) - now)}`
  return ''
}

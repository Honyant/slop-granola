// Meeting platforms and calendar matching. Pure functions shared by the tray,
// the meeting-detection prompt and their tests.
import type { CalendarEvent } from './types'

export type Platform = 'zoom' | 'meet' | 'teams' | 'webex' | 'other'

const PLATFORM_HOSTS: [RegExp, Platform][] = [
  [/(^|\.)zoom\.(us|com)$/, 'zoom'],
  [/^meet\.google\.com$/, 'meet'],
  [/^teams\.(microsoft|live)\.com$/, 'teams'],
  [/(^|\.)webex\.com$/, 'webex'],
]

export function platformOf(url: string | null): Platform | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    return PLATFORM_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? 'other'
  } catch {
    return null
  }
}

export function joinLabel(platform: Platform): string {
  switch (platform) {
    case 'zoom':
      return 'Join Zoom meeting'
    case 'meet':
      return 'Join Google Meet'
    case 'teams':
      return 'Join Teams meeting'
    case 'webex':
      return 'Join Webex meeting'
    case 'other':
      return 'Join meeting'
  }
}

/** Which platforms a desktop app can be in a call on (browsers host every web client). */
const APP_PLATFORMS: [RegExp, Platform[]][] = [
  [/^us\.zoom\./, ['zoom']],
  [/^com\.microsoft\.teams/, ['teams']],
  [/^com\.cisco\.webex/, ['webex']],
  [
    /^(com\.google\.Chrome|company\.thebrowser\.|com\.apple\.Safari|org\.mozilla\.|com\.microsoft\.edgemac|com\.brave\.|com\.operasoftware\.|com\.vivaldi\.)/,
    ['meet', 'teams', 'zoom', 'webex', 'other'],
  ],
]

/** Starting this early or ending this recently still counts as "the meeting now". */
const MATCH_EARLY_MS = 10 * 60_000
const MATCH_LATE_MS = 5 * 60_000

/**
 * The calendar event a call detected in `bundleId` most likely belongs to: one
 * that is on now (or about to be), preferring events whose meeting link the app
 * can host, then the one starting closest to now. Events with neither a link nor
 * other attendees (focus blocks, reminders) are never matched.
 */
export function eventForCall(events: readonly CalendarEvent[], bundleId: string | null, now: number): CalendarEvent | null {
  const platforms = APP_PLATFORMS.find(([pattern]) => bundleId && pattern.test(bundleId))?.[1] ?? []
  const candidates = events.filter((e) => {
    const start = Date.parse(e.start)
    const end = Date.parse(e.end)
    const isCall = e.url !== null || e.attendees.some((a) => !a.isSelf)
    return isCall && start - MATCH_EARLY_MS <= now && now <= end + MATCH_LATE_MS
  })
  const score = (e: CalendarEvent) => {
    const platform = platformOf(e.url)
    return platform && platforms.includes(platform) ? 0 : 1
  }
  return (
    [...candidates].sort((a, b) => score(a) - score(b) || Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now))[0] ??
    null
  )
}

/** Offer to join from this long before the start until this long after it. */
export const JOIN_PROMPT_LEAD_MS = 60_000
export const JOIN_PROMPT_GRACE_MS = 2 * 60_000

/** Events with a meeting link whose join prompt should be showing at `now`. */
export function joinableNow(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((e) => {
    const start = Date.parse(e.start)
    return e.url !== null && start - JOIN_PROMPT_LEAD_MS <= now && now <= start + JOIN_PROMPT_GRACE_MS
  })
}

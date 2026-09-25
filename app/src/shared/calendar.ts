import type { CalendarInfo } from './types'

/** Calendars shown when the user has not chosen: the default one (or all if none is marked). */
export function defaultVisibleCalendars(calendars: CalendarInfo[]): string[] {
  const defaults = calendars.filter((c) => c.isDefault)
  return (defaults.length ? defaults : calendars).map((c) => c.id)
}

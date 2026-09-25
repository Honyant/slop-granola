import { describe, expect, it } from 'vitest'
import { dayHeading, formatDuration, relativeDay, timeRange, trayTitle } from '@shared/time'

const at = (h: number, m = 0, day = 24) => new Date(2026, 8, day, h, m).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('time formatting', () => {
  it('formats durations like the menu bar', () => {
    expect(formatDuration(118 * 60_000 + 5_000)).toBe('1h 58m')
    expect(formatDuration(60 * 60_000)).toBe('1h')
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(45_000)).toBe('45s')
  })

  it('shares the meridiem when both ends agree', () => {
    expect(timeRange(at(16, 15), at(18, 45))).toBe('4:15 – 6:45 PM')
    expect(timeRange(at(11, 30), at(12, 15))).toBe('11:30 AM – 12:15 PM')
  })

  it('labels note groups', () => {
    const now = at(16, 44)
    expect(dayHeading(at(9), now)).toBe('Today')
    expect(dayHeading(at(9, 0, 23), now)).toBe('Yesterday')
    expect(dayHeading(at(16, 0, 22), now)).toBe('Tue, Sep 22')
    expect(relativeDay(at(16, 0, 22), now)).toBe('Tuesday')
    expect(relativeDay(at(16, 0, 9), now)).toBe('Sep 9')
  })

  it('builds the tray title for the current and next meeting', () => {
    const events = [
      { title: 'Design Offsite', start: iso(at(16, 15)), end: iso(at(18, 45)) },
      { title: 'drw oa', start: iso(at(20, 45)), end: iso(at(23)) },
    ]
    expect(trayTitle(events, at(16, 47))).toBe('Design Offsite • 1h 58m left')
    expect(trayTitle(events, at(16, 16))).toBe('Design Offsite • now')
    expect(trayTitle(events, at(19))).toBe('drw oa • in 1h 45m')
    expect(trayTitle(events, at(23, 30))).toBe('')
    const meet = [{ title: 'https://meet.google.com/xtf-eqnb-nks', start: iso(at(19, 7)), end: iso(at(20, 7)) }]
    expect(trayTitle(meet, at(19, 7))).toBe('https://meet... • now')
  })
})

import { describe, expect, it } from 'vitest'
import { eventForCall, joinableNow, joinLabel, platformOf } from '@shared/meetings'
import type { CalendarEvent } from '@shared/types'

const T = Date.parse('2026-09-24T19:00:00Z')
const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString()
const ev = (id: string, start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  calendarId: 'c',
  title: id,
  start: at(start),
  end: at(end),
  location: null,
  url: null,
  allDay: false,
  attendees: [],
  color: '#fff',
  ...extra,
})
const grace = { name: 'Grace', email: 'grace@navy.mil', isSelf: false }

describe('platformOf', () => {
  it('recognises meeting links by host, not by substring', () => {
    expect(platformOf('https://us02web.zoom.us/j/123?pwd=x')).toBe('zoom')
    expect(platformOf('https://meet.google.com/xtf-eqnb-nks')).toBe('meet')
    expect(platformOf('https://teams.microsoft.com/l/meetup-join/abc')).toBe('teams')
    expect(platformOf('https://evil.com/?next=meet.google.com')).toBe('other')
    expect(platformOf(null)).toBeNull()
    expect(joinLabel('meet')).toBe('Join Google Meet')
  })
})

describe('eventForCall', () => {
  const zoom = ev('zoom', -2, 30, { url: 'https://zoom.us/j/1' })
  const meet = ev('meet', -1, 30, { url: 'https://meet.google.com/abc-defg-hij' })
  const focus = ev('focus block', -30, 60)

  it('prefers the event whose link the calling app can host', () => {
    expect(eventForCall([meet, zoom], 'us.zoom.xos', T)?.id).toBe('zoom')
    expect(eventForCall([zoom, meet], 'com.apple.FaceTime', T)?.id).toBe('meet') // no platform: closest start
  })

  it('lets a browser host any web meeting and picks the closest start', () => {
    expect(eventForCall([zoom, meet], 'company.thebrowser.Browser', T)?.id).toBe('meet')
  })

  it('matches invites without a link when other people are on them', () => {
    const invite = ev('invite', 0, 30, { attendees: [grace] })
    expect(eventForCall([invite], 'us.zoom.xos', T)?.id).toBe('invite')
  })

  it('never matches solo blocks or events far from now', () => {
    expect(eventForCall([focus], 'us.zoom.xos', T)).toBeNull()
    expect(eventForCall([ev('later', 20, 50, { url: 'https://zoom.us/j/2' })], 'us.zoom.xos', T)).toBeNull()
    expect(eventForCall([ev('over', -60, -10, { url: 'https://zoom.us/j/3' })], 'us.zoom.xos', T)).toBeNull()
  })
})

describe('joinableNow', () => {
  it('offers to join from a minute before until two minutes after the start', () => {
    const e = ev('standup', 1, 15, { url: 'https://meet.google.com/abc' })
    expect(joinableNow([e], T - 60_000)).toEqual([])
    expect(joinableNow([e], T)).toEqual([e])
    expect(joinableNow([e], T + 3 * 60_000)).toEqual([e])
    expect(joinableNow([e], T + 3.5 * 60_000)).toEqual([])
    expect(joinableNow([ev('no link', 0, 30)], T)).toEqual([])
  })
})

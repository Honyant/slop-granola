import { describe, expect, it } from 'vitest'
import type { CalendarEvent, MeetingPrompt } from '@shared/types'
import { PromptController } from '../../src/main/services/prompts'

const T = Date.parse('2026-09-24T19:00:00Z')
const zoomCall: CalendarEvent = {
  id: 'z',
  calendarId: 'c',
  title: 'Design review',
  start: new Date(T + 30_000).toISOString(),
  end: new Date(T + 1_800_000).toISOString(),
  location: null,
  url: 'https://zoom.us/j/1',
  allDay: false,
  attendees: [],
  color: '#fff',
}
const zoomApp = { pid: 10, name: 'zoom.us', bundleId: 'us.zoom.xos' }
const arc = { pid: 20, name: 'Arc', bundleId: 'company.thebrowser.Browser' }

function harness(opts: { events?: CalendarEvent[]; recording?: boolean; ignored?: string[] } = {}) {
  let now = T
  const shown: (MeetingPrompt | null)[] = []
  const notes: (CalendarEvent | null)[] = []
  const opened: string[] = []
  const ignored = [...(opts.ignored ?? [])]
  const c = new PromptController({
    settings: () => ({ meetingDetected: true, meetingStart: true, ignoredApps: ignored }),
    upcomingEvents: () => opts.events ?? [],
    isRecording: () => opts.recording ?? false,
    show: (p) => shown.push(p),
    takeNotes: async (e) => void notes.push(e),
    openUrl: (u) => opened.push(u),
    ignoreApp: (b) => ignored.push(b),
    now: () => now,
  })
  return { c, shown, notes, opened, ignored, advance: (ms: number) => (now += ms) }
}

describe('PromptController', () => {
  it('prompts when an app starts using the mic and binds the matching calendar event', async () => {
    const h = harness({ events: [zoomCall] })
    h.c.onMicApps([zoomApp])
    expect(h.c.prompt).toMatchObject({ kind: 'detected', appName: 'zoom.us', event: { id: 'z' } })
    await h.c.act(h.c.prompt!.id, 'take-notes')
    expect(h.notes).toEqual([zoomCall])
    expect(h.c.prompt).toBeNull()
  })

  it('withdraws the prompt when the app releases the mic, and does not repeat for apps already on it', () => {
    const h = harness()
    h.c.onMicApps([arc])
    expect(h.c.prompt?.kind).toBe('detected')
    h.c.onMicApps([arc])
    expect(h.shown).toHaveLength(1)
    h.c.onMicApps([])
    expect(h.c.prompt).toBeNull()
  })

  it('stays quiet while recording, for ignored apps, and for a while after a dismissal', async () => {
    const recording = harness({ recording: true })
    recording.c.onMicApps([arc])
    expect(recording.c.prompt).toBeNull()

    const ignoring = harness({ ignored: [arc.bundleId] })
    ignoring.c.onMicApps([arc])
    expect(ignoring.c.prompt).toBeNull()

    const h = harness()
    h.c.onMicApps([arc])
    await h.c.act(h.c.prompt!.id, 'dismiss')
    h.c.onMicApps([])
    h.c.onMicApps([{ ...arc, pid: 21 }])
    expect(h.c.prompt).toBeNull()
    h.advance(11 * 60_000)
    h.c.onMicApps([])
    h.c.onMicApps([{ ...arc, pid: 22 }])
    expect(h.c.prompt?.kind).toBe('detected')
  })

  it('offers to join a linked meeting once, and join opens the link and takes notes', async () => {
    const h = harness({ events: [zoomCall] })
    h.c.tick()
    expect(h.c.prompt).toMatchObject({ kind: 'upcoming', event: { id: 'z' } })
    await h.c.act(h.c.prompt!.id, 'join')
    expect(h.opened).toEqual(['https://zoom.us/j/1'])
    expect(h.notes).toEqual([zoomCall])
    h.c.tick()
    expect(h.c.prompt).toBeNull()
  })

  it('binds the event once the calendar loads after the call was detected', async () => {
    const events: CalendarEvent[] = []
    const h = harness({ events })
    h.c.onMicApps([zoomApp])
    expect(h.c.prompt).toMatchObject({ kind: 'detected', event: null })
    events.push(zoomCall)
    h.c.tick()
    expect(h.c.prompt).toMatchObject({ kind: 'detected', event: { id: 'z' } })
    await h.c.act(h.c.prompt!.id, 'take-notes')
    expect(h.notes).toEqual([zoomCall])
  })

  it('ignore-app persists the choice', async () => {
    const h = harness()
    h.c.onMicApps([arc])
    await h.c.act(h.c.prompt!.id, 'ignore-app')
    expect(h.ignored).toEqual(['company.thebrowser.Browser'])
  })
})

import { describe, expect, it } from 'vitest'
import { AppContext } from '../../src/main/context'
import { Db } from '../../src/main/db/database'
import { attendeesOf, importGranolaExport, meetingDay, parseGranolaExport, splitTurn } from '../../src/main/services/granolaImport'

const EXPORT = `Meeting Title:  (Grace Hopper)
Date: Aug 29
Meeting participants: Sam Lee, Ghopper

Transcript:
Me: Tell me about compilers.
Them: They translate programs. Mostly.

Meeting Title: Sam Lee <> Ada Park
Date: Sep 21
Meeting participants: Sam Lee, Ada

Transcript:
Me: How are the nightly jobs?
Ada Park: They work 90% of the time.
Me: Got it.

Meeting Title: Recruiting chat
Date: Sep 21
Meeting participants: Sam Lee

Transcript:
Linus Ng: Welcome to the info session.
`

const NOW = new Date(2026, 8, 25, 2, 0).getTime() // Sep 25 2026, 2am

function context(): AppContext {
  const ctx = new AppContext(new Db(':memory:'), () => {})
  ctx.settings.update({ profile: { name: 'Sam Lee', email: 'sam@example.com' } })
  return ctx
}

describe('Granola export import', () => {
  it('parses titles, dates, participants and speaker turns', () => {
    const meetings = parseGranolaExport(EXPORT)
    expect(meetings.map((m) => m.title)).toEqual(['Grace Hopper', 'Sam Lee <> Ada Park', 'Recruiting chat'])
    expect(meetings[1]).toMatchObject({ month: 8, day: 21, year: null, participants: ['Sam Lee', 'Ada'] })
    expect(meetings[1]!.turns).toEqual([
      { speaker: 'Me', text: 'How are the nightly jobs?' },
      { speaker: 'Ada Park', text: 'They work 90% of the time.' },
      { speaker: 'Me', text: 'Got it.' },
    ])
  })

  it('puts dates in the latest year that is not in the future', () => {
    const [aug] = parseGranolaExport(EXPORT)
    expect(meetingDay(aug!, NOW).getFullYear()).toBe(2026)
    expect(meetingDay({ ...aug!, month: 11, day: 20 }, NOW).getFullYear()).toBe(2025)
  })

  it('resolves participant handles to transcript speaker names', () => {
    const [, ada, recruiting] = parseGranolaExport(EXPORT)
    expect(attendeesOf(ada!, 'Sam Lee').map((a) => a.name)).toEqual(['Ada Park'])
    expect(attendeesOf(recruiting!, 'Sam Lee').map((a) => a.name)).toEqual(['Linus Ng'])
    // An untitled meeting's "(Name)" title names the other person behind a handle.
    const [grace] = parseGranolaExport(EXPORT)
    expect(attendeesOf(grace!, 'Sam Lee').map((a) => a.name)).toEqual(['Grace Hopper'])
    expect(attendeesOf({ ...ada!, participants: ['Sam Lee', 'Apark'] }, 'Sam Lee').map((a) => a.name)).toEqual(['Ada Park'])
  })

  it('splits long turns at sentence boundaries without losing text', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const pieces = splitTurn(text)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.length <= 320)).toBe(true)
    expect(pieces.join(' ')).toBe(text)
    expect(splitTurn('We call object.age here. Version 3.5 shipped.')).toEqual(['We call object.age here. Version 3.5 shipped.'])
  })

  it('creates notes with attendees and ordered transcripts, and skips them on a second run', () => {
    const ctx = context()
    expect(importGranolaExport(ctx, EXPORT, NOW).imported).toHaveLength(3)
    const notes = ctx.notes.list()
    const ada = notes.find((n) => n.title === 'Sam Lee <> Ada Park')!
    expect(ada.attendees.map((a) => [a.name, a.isSelf])).toEqual([
      ['Sam Lee', true],
      ['Ada Park', false],
    ])
    const segments = ctx.transcripts.list(ada.id)
    expect(segments.map((s) => [s.source, s.text])).toEqual([
      ['mic', 'How are the nightly jobs?'],
      ['system', 'They work 90% of the time.'],
      ['mic', 'Got it.'],
    ])
    expect(segments.every((s, i) => i === 0 || s.startMs >= segments[i - 1]!.endMs)).toBe(true)
    // Two meetings on Sep 21 keep their file order.
    const recruiting = notes.find((n) => n.title === 'Recruiting chat')!
    expect(recruiting.meetingAt).toBeGreaterThan(ada.meetingAt)
    expect(ctx.notes.get(ada.id)!.hasTranscript).toBe(true)
    expect(ctx.search.search('nightly').map((h) => h.noteId)).toContain(ada.id)

    expect(importGranolaExport(ctx, EXPORT, NOW)).toEqual({
      imported: [],
      skipped: ['Grace Hopper', 'Sam Lee <> Ada Park', 'Recruiting chat'],
    })
  })
})

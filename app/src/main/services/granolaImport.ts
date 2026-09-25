// Imports Granola's plain-text meeting export, so notes can move over before
// Granola's history limit hides them. The export is a sequence of blocks:
//
//   Meeting Title: Sam Lee <> Ada Park
//   Date: Sep 21
//   Meeting participants: Sam Lee, Ada
//
//   Transcript:
//   Me: ...
//   Ada Park: ...
//
// It carries no times of day, no year, no emails and no per-utterance
// timestamps, so the importer fills those in: the year is the latest one that
// does not put the meeting in the future, meetings on the same day keep their
// file order, and utterance times are estimated from word counts at speaking
// pace. The text itself is imported unchanged.
import { randomUUID } from 'node:crypto'
import type { Attendee } from '@shared/types'
import type { AppContext } from '../context'

export interface ExportedMeeting {
  title: string
  /** Granola titles an untitled meeting "(Attendee Name)", which names the other person. */
  titleName: string | null
  month: number // 0-11
  day: number
  year: number | null
  participants: string[]
  turns: { speaker: string; text: string }[]
}

export interface ImportResult {
  imported: string[]
  skipped: string[]
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** Speaker labels are names, so a line starting with "Note: ..." inside a turn is not mistaken for one. */
const TURN = /^([\p{L}][\p{L} .'-]{0,59}): (.*)$/u
const HEADER = /^(Meeting Title|Date|Meeting participants|Transcript):\s?(.*)$/

export function parseGranolaExport(text: string): ExportedMeeting[] {
  const meetings: ExportedMeeting[] = []
  let current: ExportedMeeting | null = null
  let inTranscript = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const header = HEADER.exec(line)
    if (header?.[1] === 'Meeting Title') {
      const bare = /^\((.+)\)$/.exec((header[2] ?? '').trim())
      current = {
        title: cleanTitle(header[2] ?? ''),
        titleName: bare ? bare[1]!.trim() : null,
        month: 0,
        day: 1,
        year: null,
        participants: [],
        turns: [],
      }
      meetings.push(current)
      inTranscript = false
      continue
    }
    if (!current) continue
    if (header && !inTranscript) {
      const value = (header[2] ?? '').trim()
      if (header[1] === 'Date') Object.assign(current, parseDate(value))
      else if (header[1] === 'Meeting participants') current.participants = value.split(/\s*,\s*/).filter(Boolean)
      else if (header[1] === 'Transcript') inTranscript = true
      continue
    }
    if (!inTranscript || !line.trim()) continue
    const turn = TURN.exec(line)
    if (turn) current.turns.push({ speaker: turn[1]!.trim(), text: turn[2]!.trim() })
    else if (current.turns.length) current.turns.at(-1)!.text += ` ${line.trim()}` // wrapped continuation
  }
  return meetings
}

function cleanTitle(title: string): string {
  const t = title.trim()
  const bare = /^\((.+)\)$/.exec(t) // Granola exports untitled meetings as " (Attendee)"
  return (bare ? bare[1]!.trim() : t) || 'Untitled meeting'
}

function parseDate(value: string): { month: number; day: number; year: number | null } {
  const m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(value)
  const month = m ? MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) : -1
  if (!m || month < 0) throw new Error(`Unrecognised meeting date "${value}"`)
  return { month, day: Number(m[2]), year: m[3] ? Number(m[3]) : null }
}

/** Local noon on the meeting day, in the latest year that is not in the future. */
export function meetingDay(meeting: ExportedMeeting, now: number): Date {
  const today = new Date(now)
  const date = new Date(meeting.year ?? today.getFullYear(), meeting.month, meeting.day, 12)
  if (meeting.year === null && date.getTime() > now + 86_400_000) date.setFullYear(date.getFullYear() - 1)
  return date
}

/**
 * The people on the call, apart from the user. The participants line often has
 * handles ("Apark", "Ada") while transcript speakers have full names
 * ("Ada Park"), so a speaker replaces the participant it plausibly names,
 * and speakers missing from the participants line are added.
 */
export function attendeesOf(meeting: ExportedMeeting, selfName: string): Attendee[] {
  const self = norm(selfName)
  const others = meeting.participants.filter((p) => norm(p) !== self)
  const speakers = [...new Set([...meeting.turns.map((t) => t.speaker), ...(meeting.titleName ? [meeting.titleName] : [])])].filter(
    (s) => s !== 'Me' && s !== 'Them' && norm(s) !== self,
  )
  const names = [...others]
  for (const speaker of speakers) {
    const i = names.findIndex((p) => namesMatch(p, speaker))
    if (i >= 0) names[i] = speaker
    else if (names.length === 1 && speakers.length === 1)
      names[0] = speaker // a 1:1 whose handle is unrecognisable
    else names.push(speaker)
  }
  return [...new Set(names)].map((name) => ({ name, email: null, isSelf: false }))
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}]/gu, '')
}

function namesMatch(handle: string, full: string): boolean {
  const h = norm(handle)
  const parts = full.toLowerCase().split(/\s+/).map(norm).filter(Boolean)
  if (!h || !parts.length) return false
  const first = parts[0]!
  const last = parts.at(-1)!
  return (
    h === parts.join('') || h === first || h === first[0] + last || h === first + last[0] || (h.length >= 4 && parts.join('').startsWith(h))
  )
}

const WORDS_PER_SECOND = 2.6 // about 155 words a minute, ordinary conversation
const TURN_GAP_MS = 400
const SEGMENT_CHARS = 320

/** Sentence-aligned pieces, so a 78,000-character single-speaker turn stays readable and searchable. */
export function splitTurn(text: string): string[] {
  // A sentence ends at punctuation followed by whitespace, so "object.age" and "3.5" stay whole.
  const sentences = text.trim().split(/(?<=[.!?])\s+/)
  const pieces: string[] = []
  let piece = ''
  for (const sentence of sentences) {
    if (piece && piece.length + 1 + sentence.length > SEGMENT_CHARS) {
      pieces.push(piece)
      piece = ''
    }
    piece = piece ? `${piece} ${sentence}` : sentence
  }
  if (piece) pieces.push(piece)
  return pieces
}

export function importGranolaExport(ctx: AppContext, text: string, now = Date.now()): ImportResult {
  const meetings = parseGranolaExport(text)
  if (!meetings.length) throw new Error('No meetings found. Expected blocks starting with "Meeting Title:".')
  const self = ctx.self()
  const result: ImportResult = { imported: [], skipped: [] }
  const perDay = new Map<number, number>()
  for (const meeting of meetings) {
    const day = meetingDay(meeting, now)
    const order = perDay.get(day.getTime()) ?? 0
    perDay.set(day.getTime(), order + 1)
    const meetingAt = day.getTime() + order * 60_000

    const dayStart = new Date(day).setHours(0, 0, 0, 0)
    const existing = ctx.db.get<{ id: string }>(
      'SELECT id FROM notes WHERE title = ? AND trashed_at IS NULL AND meeting_at >= ? AND meeting_at < ?',
      [meeting.title, dayStart, dayStart + 86_400_000],
    )
    if (existing) {
      result.skipped.push(meeting.title)
      continue
    }

    ctx.db.transaction(() => {
      const noteId = ctx.notes.create({ title: meeting.title, meetingAt, attendees: [self, ...attendeesOf(meeting, self.name)] }, now)
      let t = meetingAt
      for (const turn of meeting.turns) {
        for (const piece of splitTurn(turn.text)) {
          const durationMs = Math.max(600, Math.round((piece.split(/\s+/).length / WORDS_PER_SECOND) * 1000))
          ctx.transcripts.insert(
            { id: randomUUID(), noteId, source: turn.speaker === 'Me' ? 'mic' : 'system', startMs: t, endMs: t + durationMs, text: piece },
            false,
          )
          t += durationMs
        }
        t += TURN_GAP_MS
      }
      ctx.notes.reindex(noteId)
    })
    result.imported.push(meeting.title)
  }
  return result
}

// Prompt construction. Pure functions: everything the model sees is built here
// from explicit inputs, so prompts are unit-testable and easy to audit.
import { counterparty, speakerLabel } from '@shared/speakers'
import type { Attendee, Template, TranscriptSegment } from '@shared/types'
import type { LlmMessage } from './client'

export interface MeetingContext {
  title: string
  meetingAt: number
  attendees: Attendee[]
  myNotes: string
  enhanced: string | null
  transcript: TranscriptSegment[]
}

/** Character budgets keep prompts inside a 32k-token context with room for the answer. */
const ENHANCE_TRANSCRIPT_BUDGET = 80_000
const CHAT_CONTEXT_BUDGET = 60_000

export function enhanceMessages(meeting: MeetingContext, template: Template, userName: string): LlmMessage[] {
  const them = counterparty(meeting.attendees)
  const system = `You are Granola, an AI notepad for meetings. You turn a user's rough notes and the meeting transcript into excellent meeting notes.

Rules:
- Output GitHub-flavoured Markdown only, starting directly with the first "###" heading. Do not repeat the title, date or attendees; no preamble, no closing remarks.
- Structure: use "###" headings and "-" bullets (nested bullets allowed). Follow the template's sections, dropping ones with nothing to say.
- The user's own notes show what they care about. Every point they wrote must appear, expanded with specifics from the transcript. Keep their wording where it is clear.
- Be concise and concrete: names, numbers, dates, decisions, owners. No filler, no speculation, nothing that is not supported by the notes or transcript.
- "Me" in the transcript is ${userName || 'the user'}; ${them ? `"${them}" is the other person on the call.` : `"Them" is everyone else on the call. Refer to people by name when the transcript makes it clear who said what.`}
- Write action items as "- [ ] Owner: task (due date if mentioned)" under the next-steps section.`

  const user = `${meetingHeader(meeting)}

## Template: ${template.name}
${template.body}

## My notes
${meeting.myNotes.trim() || '(none)'}

## Transcript
${formatTranscript(meeting.transcript, meeting.meetingAt, ENHANCE_TRANSCRIPT_BUDGET, them) || '(no transcript)'}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function titleMessages(meeting: MeetingContext): LlmMessage[] {
  return [
    {
      role: 'system',
      content: 'Name this meeting in 3 to 7 words, Title Case, no quotes, no trailing punctuation. Reply with the title only.',
    },
    {
      role: 'user',
      content: `${meeting.myNotes.slice(0, 2000)}\n\n${formatTranscript(meeting.transcript, meeting.meetingAt, 6000, counterparty(meeting.attendees))}`,
    },
  ]
}

export interface ChatContext {
  /** The note the user is looking at, if the question is scoped to it. */
  focus: MeetingContext | null
  /** Other notes that may be relevant, most relevant first. */
  related: MeetingContext[]
  now: number
  userName: string
}

export function chatMessages(context: ChatContext, history: LlmMessage[], question: string): LlmMessage[] {
  const today = new Date(context.now).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const system = `You are Granola's assistant. You answer questions about the user's meetings using only the meeting notes and transcripts provided below. Today is ${today}. The user is ${context.userName || 'the user'} ("Me" in transcripts).

- Answer directly and concisely in Markdown. Use bullets for lists.
- Cite which meeting a fact comes from when several meetings are provided.
- If the answer is not in the provided meetings, say so plainly; never invent details.`

  let budget = CHAT_CONTEXT_BUDGET
  const sections: string[] = []
  if (context.focus) {
    const text = meetingDocument(context.focus, budget)
    sections.push(`# Current meeting\n${text}`)
    budget -= text.length
  }
  for (const meeting of context.related) {
    if (budget < 2000) break
    const text = meetingDocument(meeting, Math.min(budget, 12_000))
    sections.push(`# Meeting\n${text}`)
    budget -= text.length
  }

  return [
    {
      role: 'system',
      content: `${system}\n\n${sections.join('\n\n') || '(The user has no meeting notes yet.)'}`,
    },
    ...history,
    { role: 'user', content: question },
  ]
}

function meetingDocument(meeting: MeetingContext, budget: number): string {
  const notes = meeting.enhanced?.trim() || meeting.myNotes.trim()
  const head = `${meetingHeader(meeting)}\n\n## Notes\n${notes || '(none)'}`
  const remaining = budget - head.length - 20
  if (remaining < 500) return head.slice(0, budget)
  const transcript = formatTranscript(meeting.transcript, meeting.meetingAt, remaining, counterparty(meeting.attendees))
  return transcript ? `${head}\n\n## Transcript\n${transcript}` : head
}

function meetingHeader(meeting: MeetingContext): string {
  const when = new Date(meeting.meetingAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const people = meeting.attendees.map((a) => (a.isSelf ? `${a.name} (me)` : a.name)).join(', ')
  return `Title: ${meeting.title || 'Untitled meeting'}\nDate: ${when}${people ? `\nAttendees: ${people}` : ''}`
}

/**
 * "[mm:ss] Speaker: text" lines, merging consecutive segments from the same
 * speaker. Over budget, the middle is elided: openings and conclusions carry
 * the most signal in meetings.
 */
export function formatTranscript(
  segments: TranscriptSegment[],
  originMs: number,
  budget: number,
  /** Name for the far side when it is one known person. */
  them: string | null = null,
): string {
  const lines: string[] = []
  let current: {
    source: TranscriptSegment['source']
    start: number
    text: string
  } | null = null
  const origin = Math.min(originMs, segments[0]?.startMs ?? originMs)
  for (const s of segments) {
    if (current && current.source === s.source) {
      current.text += ` ${s.text}`
      continue
    }
    if (current) lines.push(line(current, origin, them))
    current = { source: s.source, start: s.startMs, text: s.text }
  }
  if (current) lines.push(line(current, origin, them))

  const full = lines.join('\n')
  if (full.length <= budget) return full
  const half = Math.floor((budget - 40) / 2)
  return `${full.slice(0, half)}\n[… transcript truncated …]\n${full.slice(full.length - half)}`
}

function line(turn: { source: TranscriptSegment['source']; start: number; text: string }, origin: number, them: string | null): string {
  const seconds = Math.max(0, Math.round((turn.start - origin) / 1000))
  const stamp = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  return `[${stamp}] ${speakerLabel(turn.source, them)}: ${turn.text}`
}

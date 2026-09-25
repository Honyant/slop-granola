// Assembles what the LLM needs to know about a note.
import { docToMarkdown } from '@shared/doc'
import type { AppContext } from '../context'
import type { MeetingContext } from '../llm/prompts'

export function meetingContext(ctx: AppContext, noteId: string): MeetingContext | null {
  const note = ctx.notes.get(noteId)
  if (!note) return null
  return {
    title: note.title,
    meetingAt: note.meetingAt,
    attendees: note.attendees,
    myNotes: docToMarkdown(note.doc),
    enhanced: note.enhanced,
    transcript: ctx.transcripts.list(noteId),
  }
}

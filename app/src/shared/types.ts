// Domain types shared by the main process and the renderer. Everything here is
// plain JSON so it crosses the IPC boundary unchanged.

/** ProseMirror/TipTap document JSON. Kept opaque outside the editor. */
export type DocJSON = { type: 'doc'; content?: unknown[] }

export type Visibility = 'private' | 'workspace'

export interface Person {
  name: string
  email: string | null
}

export interface Attendee extends Person {
  isSelf: boolean
}

export interface CalendarEventRef {
  id: string
  calendarId: string
  title: string
  start: string // ISO-8601
  end: string
  location: string | null
  url: string | null
}

export interface NoteSummary {
  id: string
  title: string
  createdAt: number // unix ms
  updatedAt: number
  /** Start of the meeting the note belongs to, or createdAt for ad-hoc notes. */
  meetingAt: number
  visibility: Visibility
  attendees: Attendee[]
  folderIds: string[]
  hasTranscript: boolean
  isRecording: boolean
}

export interface Note extends NoteSummary {
  doc: DocJSON
  /** AI-enhanced notes as markdown; null until generated. */
  enhanced: string | null
  /** Which view the user last looked at. */
  view: 'mine' | 'enhanced'
  templateId: string | null
  event: CalendarEventRef | null
  trashedAt: number | null
}

export type AudioSource = 'mic' | 'system'

export interface TranscriptSegment {
  id: string
  noteId: string
  source: AudioSource
  /** Absolute unix ms, derived from the capture timeline, not arrival time. */
  startMs: number
  endMs: number
  text: string
  final: boolean
}

export interface Space {
  id: 'private' | 'workspace'
  name: string
}

export interface Folder {
  id: string
  name: string
  noteCount: number
  createdAt: number
}

export interface PersonRow {
  name: string
  email: string
  isSelf: boolean
  lastNoteAt: number
  noteCount: number
}

export interface CompanyRow {
  domain: string
  name: string
  lastNoteAt: number
  noteCount: number
}

export type RecipeSection = 'before' | 'during' | 'after' | 'anytime'

export interface Recipe {
  id: string
  slug: string
  title: string
  description: string
  prompt: string
  author: string
  uses: number
  section: RecipeSection
  builtin: boolean
}

export interface Template {
  id: string
  name: string
  description: string
  /** Markdown skeleton the enhancer should follow. */
  body: string
  builtin: boolean
}

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  threadId: string
  role: ChatRole
  content: string
  createdAt: number
  status: 'done' | 'streaming' | 'error'
}

export interface ChatThread {
  id: string
  title: string
  noteId: string | null
  createdAt: number
  messages: ChatMessage[]
}

export interface CalendarInfo {
  id: string
  title: string
  color: string
  source: string
  /** The account's default calendar; shown until the user picks calendars. */
  isDefault: boolean
}

export interface CalendarEvent extends CalendarEventRef {
  allDay: boolean
  attendees: Attendee[]
  color: string
}

export type PermissionState = 'granted' | 'denied' | 'not_determined' | 'restricted' | 'unknown'

export interface Permissions {
  microphone: PermissionState
  calendar: PermissionState
  systemAudio: PermissionState
}

export interface InputDevice {
  uid: string
  name: string
  isDefault: boolean
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface RecordingState {
  noteId: string
  startedAt: number
  paused: boolean
  mic: { device: InputDevice | null; level: number; connection: ConnectionState }
  system: { level: number; connection: ConnectionState }
  error: string | null
}

export interface SearchHit {
  noteId: string
  title: string
  snippet: string
  meetingAt: number
}

export interface UsageStats {
  notes: number
  notesThisWeek: number
  transcribedMinutes: number
  words: number
  /** Notes per ISO week for the last 12 weeks, oldest first. */
  weekly: { weekStart: number; notes: number }[]
}

/** The "Meeting detected" / "join" prompt shown top-right, outside the main window. */
export type MeetingPrompt =
  | { id: string; kind: 'detected'; appName: string; bundleId: string | null; event: CalendarEvent | null }
  | { id: string; kind: 'upcoming'; event: CalendarEvent }

export type PromptAction = 'take-notes' | 'join' | 'dismiss' | 'expire' | 'ignore-app'

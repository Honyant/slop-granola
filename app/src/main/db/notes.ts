import { randomUUID } from 'node:crypto'
import { docToText } from '@shared/doc'
import type { NotePatch } from '@shared/ipc'
import type { Attendee, CalendarEventRef, DocJSON, Note, NoteSummary, Visibility } from '@shared/types'
import type { Db } from './database'

interface NoteRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  meeting_at: number
  trashed_at: number | null
  visibility: Visibility
  doc: string
  enhanced: string | null
  view: Note['view']
  template_id: string | null
  event: string | null
  has_transcript: number
}

interface AttendeeRow {
  note_id: string
  name: string
  email: string | null
  is_self: number
}

export interface NewNote {
  title?: string
  meetingAt?: number
  event?: CalendarEventRef | null
  attendees: Attendee[]
  folderId?: string
  templateId?: string | null
}

const SUMMARY_COLUMNS = `
  n.id, n.title, n.created_at, n.updated_at, n.meeting_at, n.trashed_at, n.visibility,
  EXISTS (SELECT 1 FROM transcript_segments s WHERE s.note_id = n.id AND s.suppressed = 0) AS has_transcript`

export class NotesRepo {
  constructor(private readonly db: Db) {}

  list(): NoteSummary[] {
    const rows = this.db.all<NoteRow>(`SELECT ${SUMMARY_COLUMNS} FROM notes n WHERE n.trashed_at IS NULL ORDER BY n.meeting_at DESC`)
    return this.hydrate(rows)
  }

  listInFolder(folderId: string): NoteSummary[] {
    const rows = this.db.all<NoteRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM notes n JOIN note_folders f ON f.note_id = n.id
       WHERE f.folder_id = ? AND n.trashed_at IS NULL ORDER BY n.meeting_at DESC`,
      [folderId],
    )
    return this.hydrate(rows)
  }

  get(id: string): Note | null {
    const row = this.db.get<NoteRow>(
      `SELECT ${SUMMARY_COLUMNS}, n.doc, n.enhanced, n.view, n.template_id, n.event FROM notes n WHERE n.id = ?`,
      [id],
    )
    if (!row) return null
    const [summary] = this.hydrate([row])
    return {
      ...summary!,
      doc: JSON.parse(row.doc) as DocJSON,
      enhanced: row.enhanced,
      view: row.view,
      templateId: row.template_id,
      event: row.event ? (JSON.parse(row.event) as CalendarEventRef) : null,
      trashedAt: row.trashed_at,
    }
  }

  findByEvent(eventKey: string): string | null {
    return this.db.get<{ id: string }>('SELECT id FROM notes WHERE event_key = ?', [eventKey])?.id ?? null
  }

  create(input: NewNote, now = Date.now()): string {
    const id = randomUUID()
    const event = input.event ?? null
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO notes (id, title, created_at, updated_at, meeting_at, event, event_key, template_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title ?? '',
          now,
          now,
          input.meetingAt ?? now,
          event ? JSON.stringify(event) : null,
          event ? eventKey(event.id, event.start) : null,
          input.templateId ?? null,
        ],
      )
      for (const a of input.attendees) {
        this.db.run('INSERT INTO attendees (note_id, name, email, is_self) VALUES (?, ?, ?, ?)', [
          id,
          a.name,
          a.email?.toLowerCase() ?? null,
          a.isSelf ? 1 : 0,
        ])
      }
      if (input.folderId) this.setFolder([id], input.folderId, true)
      this.reindex(id)
    })
    return id
  }

  update(id: string, patch: NotePatch, now = Date.now()): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.title !== undefined) set('title', patch.title)
    if (patch.doc !== undefined) {
      set('doc', JSON.stringify(patch.doc))
      set('body_text', docToText(patch.doc))
    }
    if (patch.enhanced !== undefined) set('enhanced', patch.enhanced)
    if (patch.view !== undefined) set('view', patch.view)
    if (patch.visibility !== undefined) set('visibility', patch.visibility)
    if (patch.templateId !== undefined) set('template_id', patch.templateId)
    if (sets.length === 0) return
    set('updated_at', now)
    this.db.transaction(() => {
      this.db.run(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
      if (patch.title !== undefined || patch.doc !== undefined || patch.enhanced !== undefined) this.reindex(id)
    })
  }

  trash(ids: string[], now = Date.now()): void {
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.run('UPDATE notes SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL', [now, id])
        this.db.run('DELETE FROM notes_fts WHERE note_id = ?', [id])
      }
    })
  }

  /** Trashed notes, most recently trashed first, with when each was trashed. */
  listTrashed(): (NoteSummary & { trashedAt: number })[] {
    const rows = this.db.all<NoteRow>(`SELECT ${SUMMARY_COLUMNS} FROM notes n WHERE n.trashed_at IS NOT NULL ORDER BY n.trashed_at DESC`)
    return this.hydrate(rows).map((note, i) => ({ ...note, trashedAt: rows[i]!.trashed_at! }))
  }

  restore(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.run('UPDATE notes SET trashed_at = NULL WHERE id = ?', [id])
        this.reindex(id)
      }
    })
  }

  /** Deletes trashed notes now; notes not in the trash are left alone. */
  deleteForever(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.db.run('DELETE FROM notes WHERE id = ? AND trashed_at IS NOT NULL', [id])
    })
  }

  /** Permanently deletes notes trashed before `cutoff`. */
  purgeTrash(cutoff: number): number {
    return this.db.run('DELETE FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?', [cutoff]).changes
  }

  setFolder(noteIds: string[], folderId: string, member: boolean): void {
    this.db.transaction(() => {
      for (const noteId of noteIds) {
        this.db.run(
          member
            ? 'INSERT OR IGNORE INTO note_folders (note_id, folder_id) VALUES (?, ?)'
            : 'DELETE FROM note_folders WHERE note_id = ? AND folder_id = ?',
          [noteId, folderId],
        )
      }
    })
  }

  /** Rebuilds the full-text row for a note (title, own notes + enhanced, transcript). */
  reindex(id: string): void {
    const row = this.db.get<{ title: string; body_text: string; enhanced: string | null; trashed_at: number | null }>(
      'SELECT title, body_text, enhanced, trashed_at FROM notes WHERE id = ?',
      [id],
    )
    this.db.run('DELETE FROM notes_fts WHERE note_id = ?', [id])
    if (!row || row.trashed_at !== null) return
    const transcript = this.db
      .all<{ text: string }>('SELECT text FROM transcript_segments WHERE note_id = ? AND suppressed = 0 ORDER BY start_ms', [id])
      .map((s) => s.text)
      .join(' ')
    this.db.run('INSERT INTO notes_fts (note_id, title, body, transcript) VALUES (?, ?, ?, ?)', [
      id,
      row.title,
      [row.body_text, row.enhanced ?? ''].join('\n'),
      transcript,
    ])
  }

  private hydrate(rows: NoteRow[]): NoteSummary[] {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    const attendees = new Map<string, Attendee[]>()
    for (const a of this.db.all<AttendeeRow>(
      `SELECT note_id, name, email, is_self FROM attendees WHERE note_id IN (${placeholders}) ORDER BY rowid`,
      ids,
    )) {
      const list = attendees.get(a.note_id) ?? []
      list.push({ name: a.name, email: a.email, isSelf: a.is_self === 1 })
      attendees.set(a.note_id, list)
    }
    const folders = new Map<string, string[]>()
    for (const f of this.db.all<{ note_id: string; folder_id: string }>(
      `SELECT note_id, folder_id FROM note_folders WHERE note_id IN (${placeholders})`,
      ids,
    )) {
      const list = folders.get(f.note_id) ?? []
      list.push(f.folder_id)
      folders.set(f.note_id, list)
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      meetingAt: r.meeting_at,
      visibility: r.visibility,
      attendees: attendees.get(r.id) ?? [],
      folderIds: folders.get(r.id) ?? [],
      hasTranscript: r.has_transcript === 1,
      isRecording: false,
    }))
  }
}

export const eventKey = (eventId: string, start: string): string => `${eventId}|${start}`

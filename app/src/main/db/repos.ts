// Small repositories that do not warrant a file each.
import { randomUUID } from 'node:crypto'
import { parseSettings, mergeSettings, SECRET_FIELDS, type Settings, type SettingsPatch } from '@shared/settings'
import type {
  AudioSource,
  ChatMessage,
  ChatThread,
  CompanyRow,
  Folder,
  PersonRow,
  Recipe,
  SearchHit,
  Template,
  TranscriptSegment,
  UsageStats,
} from '@shared/types'
import type { Db } from './database'

export class TranscriptRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent on segment id, so a replayed final can never be stored twice. */
  insert(segment: Omit<TranscriptSegment, 'final'>, suppressed: boolean): void {
    this.db.run(
      `INSERT OR IGNORE INTO transcript_segments (id, note_id, source, start_ms, end_ms, text, suppressed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [segment.id, segment.noteId, segment.source, segment.startMs, segment.endMs, segment.text, suppressed ? 1 : 0],
    )
  }

  list(noteId: string): TranscriptSegment[] {
    return this.db
      .all<{ id: string; source: AudioSource; start_ms: number; end_ms: number; text: string }>(
        `SELECT id, source, start_ms, end_ms, text FROM transcript_segments
         WHERE note_id = ? AND suppressed = 0 ORDER BY start_ms, rowid`,
        [noteId],
      )
      .map((r) => ({
        id: r.id,
        noteId,
        source: r.source,
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text,
        final: true,
      }))
  }
}

export class FoldersRepo {
  constructor(private readonly db: Db) {}

  list(): Folder[] {
    return this.db
      .all<{ id: string; name: string; created_at: number; note_count: number }>(
        `SELECT f.id, f.name, f.created_at,
           (SELECT COUNT(*) FROM note_folders nf JOIN notes n ON n.id = nf.note_id
            WHERE nf.folder_id = f.id AND n.trashed_at IS NULL) AS note_count
         FROM folders f ORDER BY f.name COLLATE NOCASE`,
      )
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, noteCount: r.note_count }))
  }

  create(name: string, now = Date.now()): Folder {
    const id = randomUUID()
    const trimmed = name.trim() || 'Untitled folder'
    this.db.run('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)', [id, trimmed, now])
    return { id, name: trimmed, createdAt: now, noteCount: 0 }
  }

  rename(id: string, name: string): void {
    this.db.run('UPDATE folders SET name = ? WHERE id = ?', [name.trim() || 'Untitled folder', id])
  }

  remove(id: string): void {
    this.db.run('DELETE FROM folders WHERE id = ?', [id])
  }
}

/** Consumer mail providers: an address there says nothing about an employer. */
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'hey.com',
])

export class PeopleRepo {
  constructor(private readonly db: Db) {}

  list(): PersonRow[] {
    return this.db
      .all<{ email: string; name: string; is_self: number; last_note_at: number; note_count: number }>(
        `SELECT a.email, MAX(a.name) AS name, MAX(a.is_self) AS is_self,
                MAX(n.meeting_at) AS last_note_at, COUNT(DISTINCT n.id) AS note_count
         FROM attendees a JOIN notes n ON n.id = a.note_id
         WHERE n.trashed_at IS NULL AND a.email IS NOT NULL
         GROUP BY a.email
         ORDER BY is_self DESC, last_note_at DESC`,
      )
      .map((r) => ({
        email: r.email,
        name: r.name,
        isSelf: r.is_self === 1,
        lastNoteAt: r.last_note_at,
        noteCount: r.note_count,
      }))
  }

  companies(): CompanyRow[] {
    const byDomain = new Map<string, CompanyRow & { notes: Set<string> }>()
    const rows = this.db.all<{ email: string; note_id: string; meeting_at: number }>(
      `SELECT a.email, a.note_id, n.meeting_at FROM attendees a JOIN notes n ON n.id = a.note_id
       WHERE n.trashed_at IS NULL AND a.email IS NOT NULL AND a.is_self = 0`,
    )
    for (const r of rows) {
      const domain = r.email.split('@')[1]
      if (!domain || PERSONAL_DOMAINS.has(domain)) continue
      const company = byDomain.get(domain) ?? { domain, name: domain, lastNoteAt: 0, noteCount: 0, notes: new Set() }
      company.notes.add(r.note_id)
      company.noteCount = company.notes.size
      company.lastNoteAt = Math.max(company.lastNoteAt, r.meeting_at)
      byDomain.set(domain, company)
    }
    return [...byDomain.values()].map(({ notes: _notes, ...company }) => company).sort((a, b) => b.lastNoteAt - a.lastNoteAt)
  }
}

export class ChatRepo {
  constructor(private readonly db: Db) {}

  createThread(title: string, noteId: string | null, now = Date.now()): string {
    const id = randomUUID()
    this.db.run('INSERT INTO chat_threads (id, title, note_id, created_at) VALUES (?, ?, ?, ?)', [id, title, noteId, now])
    return id
  }

  addMessage(threadId: string, role: ChatMessage['role'], content: string, status: ChatMessage['status']): string {
    const id = randomUUID()
    this.db.run('INSERT INTO chat_messages (id, thread_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      threadId,
      role,
      content,
      status,
      Date.now(),
    ])
    return id
  }

  finishMessage(id: string, content: string, status: ChatMessage['status']): void {
    this.db.run('UPDATE chat_messages SET content = ?, status = ? WHERE id = ?', [content, status, id])
  }

  /** Messages left "streaming" by a crash or quit are closed out on startup. */
  failInterrupted(): void {
    this.db.run(`UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'`)
  }

  thread(id: string): ChatThread | null {
    const t = this.db.get<{ id: string; title: string; note_id: string | null; created_at: number }>(
      'SELECT id, title, note_id, created_at FROM chat_threads WHERE id = ?',
      [id],
    )
    if (!t) return null
    const messages = this.db
      .all<{ id: string; role: ChatMessage['role']; content: string; status: ChatMessage['status']; created_at: number }>(
        'SELECT id, role, content, status, created_at FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid',
        [id],
      )
      .map((m) => ({ id: m.id, threadId: id, role: m.role, content: m.content, status: m.status, createdAt: m.created_at }))
    return { id: t.id, title: t.title, noteId: t.note_id, createdAt: t.created_at, messages }
  }

  threads(): Omit<ChatThread, 'messages'>[] {
    return this.db
      .all<{ id: string; title: string; note_id: string | null; created_at: number }>(
        'SELECT id, title, note_id, created_at FROM chat_threads ORDER BY created_at DESC LIMIT 50',
      )
      .map((t) => ({ id: t.id, title: t.title, noteId: t.note_id, createdAt: t.created_at }))
  }
}

export class CatalogRepo {
  constructor(private readonly db: Db) {}

  recipes(): Recipe[] {
    return this.db
      .all<Omit<Recipe, 'builtin'> & { builtin: number }>(
        'SELECT id, slug, title, description, prompt, author, uses, section, builtin FROM recipes ORDER BY rowid',
      )
      .map((r) => ({ ...r, builtin: r.builtin === 1 }))
  }

  recipe(id: string): Recipe | null {
    return this.recipes().find((r) => r.id === id) ?? null
  }

  recordRecipeUse(id: string): void {
    this.db.run('UPDATE recipes SET uses = uses + 1 WHERE id = ?', [id])
  }

  templates(): Template[] {
    return this.db
      .all<Omit<Template, 'builtin'> & { builtin: number }>('SELECT id, name, description, body, builtin FROM templates ORDER BY rowid')
      .map((t) => ({ ...t, builtin: t.builtin === 1 }))
  }
}

/** Encrypts credential fields at rest. The default leaves them as they are (tests, no Keychain). */
export interface SecretBox {
  seal(plain: string): string
  open(stored: string): string
}

const passthrough: SecretBox = { seal: (s) => s, open: (s) => s }

export class SettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox = passthrough,
  ) {}

  get(): Settings {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE id = 1')
    let raw: unknown = {}
    try {
      raw = row ? JSON.parse(row.value) : {}
    } catch {
      // Unparseable row: fall through to defaults.
    }
    return parseSettings(mapSecrets(raw, (v) => this.secrets.open(v)))
  }

  update(patch: SettingsPatch): Settings {
    const next = mergeSettings(this.get(), patch)
    this.db.run('INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', [
      JSON.stringify(mapSecrets(next, (v) => this.secrets.seal(v))),
    ])
    return next
  }
}

/** Copy of `raw` with every credential field passed through `fn`. */
function mapSecrets<T>(raw: T, fn: (value: string) => string): T {
  if (raw === null || typeof raw !== 'object') return raw
  const copy = structuredClone(raw) as Record<string, Record<string, unknown> | undefined>
  for (const [section, field] of SECRET_FIELDS) {
    const group = copy[section]
    if (group && typeof group[field] === 'string') group[field] = fn(group[field] as string)
  }
  return copy as T
}

export class SearchRepo {
  constructor(private readonly db: Db) {}

  /** Search-box semantics: every word must match (as a prefix). */
  search(query: string, limit = 20): SearchHit[] {
    return this.query(toFtsQuery(query, 'AND'), limit)
  }

  /** Note ids ranked by relevance for grounding chat answers: any word may match. */
  rank(query: string, limit: number): string[] {
    return this.query(toFtsQuery(query, 'OR'), limit).map((h) => h.noteId)
  }

  private query(match: string | null, limit: number): SearchHit[] {
    if (!match) return []
    return this.db
      .all<{ note_id: string; title: string; snippet: string; meeting_at: number }>(
        `SELECT f.note_id, n.title, n.meeting_at,
                snippet(notes_fts, -1, '«', '»', '…', 12) AS snippet
         FROM notes_fts f JOIN notes n ON n.id = f.note_id
         WHERE notes_fts MATCH ? AND n.trashed_at IS NULL
         ORDER BY bm25(notes_fts, 0, 8.0, 2.0, 1.0) LIMIT ?`,
        [match, limit],
      )
      .map((r) => ({ noteId: r.note_id, title: r.title, snippet: r.snippet, meetingAt: r.meeting_at }))
  }
}

/**
 * Turns free text into a safe FTS5 query: every word becomes a quoted prefix
 * term so user input can never be parsed as FTS syntax (quotes, NEAR, *, -).
 */
export function toFtsQuery(input: string, op: 'AND' | 'OR'): string | null {
  const terms = input
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((t) => t.length > 1 || /\d/.test(t))
  if (!terms?.length) return null
  return [...new Set(terms)].map((t) => `"${t}"*`).join(` ${op} `)
}

const WEEK_MS = 7 * 24 * 3600 * 1000

export class StatsRepo {
  constructor(private readonly db: Db) {}

  usage(now = Date.now()): UsageStats {
    const weekStart = startOfWeek(now)
    const counts = this.db.get<{ notes: number; this_week: number }>(
      `SELECT COUNT(*) AS notes, COALESCE(SUM(meeting_at >= ?), 0) AS this_week FROM notes WHERE trashed_at IS NULL`,
      [weekStart],
    )!
    const transcript = this.db.get<{ ms: number | null; words: number | null }>(
      `SELECT SUM(s.end_ms - s.start_ms) AS ms,
              SUM(LENGTH(s.text) - LENGTH(REPLACE(s.text, ' ', '')) + 1) AS words
       FROM transcript_segments s JOIN notes n ON n.id = s.note_id
       WHERE s.suppressed = 0 AND n.trashed_at IS NULL`,
    )!
    const first = weekStart - 11 * WEEK_MS
    const byWeek = new Map<number, number>()
    for (const { meeting_at } of this.db.all<{ meeting_at: number }>(
      'SELECT meeting_at FROM notes WHERE trashed_at IS NULL AND meeting_at >= ?',
      [first],
    )) {
      const week = startOfWeek(meeting_at)
      byWeek.set(week, (byWeek.get(week) ?? 0) + 1)
    }
    return {
      notes: counts.notes,
      notesThisWeek: counts.this_week,
      transcribedMinutes: Math.round((transcript.ms ?? 0) / 60_000),
      words: transcript.words ?? 0,
      weekly: Array.from({ length: 12 }, (_, i) => {
        const start = startOfWeek(first + i * WEEK_MS + WEEK_MS / 2)
        return { weekStart: start, notes: byWeek.get(start) ?? 0 }
      }),
    }
  }
}

/** Local midnight at the start of the Monday-based week containing `ms`. */
function startOfWeek(ms: number): number {
  const d = new Date(ms)
  const monday = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - monday).getTime()
}

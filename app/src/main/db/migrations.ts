// Append-only list of schema migrations; index + 1 is the resulting
// `PRAGMA user_version`. Never edit a shipped migration — add a new one.
import type { Db } from './database'
import { BUILTIN_RECIPES, BUILTIN_TEMPLATES } from './seeds'

export const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE notes (
        id          TEXT PRIMARY KEY,
        title       TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        meeting_at  INTEGER NOT NULL,
        trashed_at  INTEGER,
        visibility  TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
        doc         TEXT    NOT NULL DEFAULT '{"type":"doc"}',
        body_text   TEXT    NOT NULL DEFAULT '',
        enhanced    TEXT,
        view        TEXT    NOT NULL DEFAULT 'mine' CHECK (view IN ('mine', 'enhanced')),
        template_id TEXT,
        event       TEXT,
        -- "<calendar event id>|<occurrence start>": recurring events share an id.
        event_key   TEXT UNIQUE
      );
      CREATE INDEX notes_by_meeting ON notes (meeting_at DESC) WHERE trashed_at IS NULL;

      CREATE TABLE attendees (
        note_id TEXT    NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
        name    TEXT    NOT NULL,
        email   TEXT,
        is_self INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX attendees_by_note ON attendees (note_id);
      CREATE INDEX attendees_by_email ON attendees (email);

      CREATE TABLE transcript_segments (
        id         TEXT PRIMARY KEY,
        note_id    TEXT    NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
        source     TEXT    NOT NULL CHECK (source IN ('mic', 'system')),
        start_ms   INTEGER NOT NULL,
        end_ms     INTEGER NOT NULL,
        text       TEXT    NOT NULL,
        -- 1 when the mic segment is the far side leaking through the speakers.
        suppressed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX segments_by_note ON transcript_segments (note_id, start_ms);

      CREATE TABLE folders (
        id         TEXT PRIMARY KEY,
        name       TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE note_folders (
        note_id   TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
        folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, folder_id)
      );
      CREATE INDEX note_folders_by_folder ON note_folders (folder_id);

      CREATE TABLE chat_threads (
        id         TEXT PRIMARY KEY,
        title      TEXT    NOT NULL,
        note_id    TEXT REFERENCES notes (id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE chat_messages (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT    NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
        role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT    NOT NULL,
        status     TEXT    NOT NULL CHECK (status IN ('done', 'streaming', 'error')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX messages_by_thread ON chat_messages (thread_id, created_at);

      CREATE TABLE recipes (
        id          TEXT PRIMARY KEY,
        slug        TEXT    NOT NULL UNIQUE,
        title       TEXT    NOT NULL,
        description TEXT    NOT NULL,
        prompt      TEXT    NOT NULL,
        author      TEXT    NOT NULL,
        uses        INTEGER NOT NULL DEFAULT 0,
        section     TEXT    NOT NULL CHECK (section IN ('before', 'during', 'after', 'anytime')),
        builtin     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE templates (
        id          TEXT PRIMARY KEY,
        name        TEXT    NOT NULL,
        description TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        builtin     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE settings (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE notes_fts USING fts5 (
        note_id UNINDEXED, title, body, transcript,
        tokenize = 'porter unicode61'
      );
    `)
    for (const r of BUILTIN_RECIPES) {
      db.run(
        `INSERT INTO recipes (id, slug, title, description, prompt, author, uses, section, builtin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [`recipe-${r.slug}`, r.slug, r.title, r.description, r.prompt, r.author, r.uses, r.section],
      )
    }
    for (const t of BUILTIN_TEMPLATES) {
      db.run(`INSERT INTO templates (id, name, description, body, builtin) VALUES (?, ?, ?, ?, 1)`, [t.id, t.name, t.description, t.body])
    }
  },
]

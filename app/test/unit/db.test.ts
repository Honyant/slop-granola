import { describe, expect, it, beforeEach } from 'vitest'
import { Db } from '../../src/main/db/database'
import { NotesRepo } from '../../src/main/db/notes'
import { FoldersRepo, PeopleRepo, SearchRepo, SettingsRepo, TranscriptRepo, toFtsQuery } from '../../src/main/db/repos'

const me = { name: 'Sam Lee', email: 'me@example.com', isSelf: true }

describe('database', () => {
  let db: Db
  let notes: NotesRepo
  beforeEach(() => {
    db = new Db(':memory:')
    notes = new NotesRepo(db)
  })

  it('migrates and seeds recipes/templates exactly once', () => {
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recipes')!.n).toBeGreaterThan(10)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(1)
  })

  it('creates, updates and lists notes newest meeting first', () => {
    const a = notes.create({ title: 'Older', meetingAt: 1000, attendees: [me] })
    const b = notes.create({ title: 'Newer', meetingAt: 2000, attendees: [me] })
    notes.update(a, { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] } })
    expect(notes.list().map((n) => n.id)).toEqual([b, a])
    const full = notes.get(a)!
    expect(full.attendees).toEqual([me])
    expect(full.doc.content).toHaveLength(1)
  })

  it('trash hides notes from lists and search', () => {
    const search = new SearchRepo(db)
    const id = notes.create({ title: 'Quarterly planning', attendees: [me] })
    expect(search.search('quarter').map((h) => h.noteId)).toEqual([id])
    notes.trash([id])
    expect(notes.list()).toEqual([])
    expect(search.search('quarter')).toEqual([])
  })

  it('indexes transcripts but skips echo-suppressed segments', () => {
    const search = new SearchRepo(db)
    const transcripts = new TranscriptRepo(db)
    const id = notes.create({ title: 't', attendees: [me] })
    transcripts.insert({ id: 's1', noteId: id, source: 'system', startMs: 0, endMs: 1, text: 'Airbus and Ferrari' }, false)
    transcripts.insert({ id: 'm1', noteId: id, source: 'mic', startMs: 0, endMs: 1, text: 'zeppelin' }, true)
    notes.reindex(id)
    expect(search.search('ferrari')).toHaveLength(1)
    expect(search.search('zeppelin')).toHaveLength(0)
    expect(transcripts.list(id).map((s) => s.text)).toEqual(['Airbus and Ferrari'])
  })

  it('counts folder membership and ignores trashed notes', () => {
    const folders = new FoldersRepo(db)
    const f = folders.create('CS 378H')
    const a = notes.create({ title: 'a', attendees: [me], folderId: f.id })
    notes.create({ title: 'b', attendees: [me], folderId: f.id })
    expect(folders.list()[0]!.noteCount).toBe(2)
    notes.trash([a])
    expect(folders.list()[0]!.noteCount).toBe(1)
  })

  it('derives people and companies from attendees, excluding personal domains', () => {
    const people = new PeopleRepo(db)
    notes.create({
      title: 'x',
      meetingAt: 5,
      attendees: [me, { name: 'Ada', email: 'Ada@Acme.dev', isSelf: false }, { name: 'Eric', email: 'eric@gmail.com', isSelf: false }],
    })
    notes.create({ title: 'y', meetingAt: 9, attendees: [me, { name: 'Ada', email: 'ada@acme.dev', isSelf: false }] })
    const list = people.list()
    expect(list[0]).toMatchObject({ email: 'me@example.com', isSelf: true, noteCount: 2 })
    expect(list.find((p) => p.email === 'ada@acme.dev')).toMatchObject({ noteCount: 2, lastNoteAt: 9 })
    expect(people.companies()).toEqual([{ domain: 'acme.dev', name: 'acme.dev', lastNoteAt: 9, noteCount: 2 }])
  })

  it('stores credentials sealed and reads them back opened', () => {
    const box = { seal: (s: string) => `sealed(${s})`, open: (s: string) => s.replace(/^sealed\((.*)\)$/, '$1') }
    const settings = new SettingsRepo(db, box)
    settings.update({ llm: { apiKey: 'sk-secret' }, transcription: { deepgramApiKey: 'dg-key' } })
    const raw = db.get<{ value: string }>('SELECT value FROM settings')!.value
    expect(raw).toContain('sealed(sk-secret)')
    expect(raw).not.toContain('"sk-secret"')
    expect(settings.get().llm.apiKey).toBe('sk-secret')
    expect(settings.get().transcription.deepgramApiKey).toBe('dg-key')
  })

  it('never erases a credential it cannot decrypt, and undefined fields leave settings alone', () => {
    // The Keychain refuses this box (a new code signature, access denied): every open yields ''.
    const locked = { seal: (v: string) => (v ? `enc:v1:${v}` : v), open: () => '' }
    const settings = new SettingsRepo(db, locked)
    settings.update({ transcription: { url: 'ws://h/v1/listen', token: 'tok' }, llm: { apiKey: 'key' } })
    settings.update({ profile: { name: 'Ada' }, transcription: { url: undefined, token: undefined } })
    const stored = () => JSON.parse(db.get<{ value: string }>('SELECT value FROM settings')!.value)
    expect(stored().transcription).toMatchObject({ url: 'ws://h/v1/listen', token: 'enc:v1:tok' })
    expect(stored().llm.apiKey).toBe('enc:v1:key')
    // Setting it explicitly still replaces it.
    settings.update({ llm: { apiKey: 'new' } })
    expect(stored().llm.apiKey).toBe('enc:v1:new')
  })

  it('settings survive a corrupt row and merge nested patches', () => {
    const settings = new SettingsRepo(db)
    expect(settings.get().calendar.showInMenuBar).toBe(true)
    settings.update({ calendar: { showInMenuBar: false } })
    expect(settings.get().calendar).toMatchObject({ showInMenuBar: false, showEventsWithoutParticipants: true })
    db.run(`UPDATE settings SET value = '{not json'`)
    expect(settings.get().calendar.showInMenuBar).toBe(true)
  })
})

describe('toFtsQuery', () => {
  it('quotes every term so FTS syntax in user input is inert', () => {
    expect(toFtsQuery('NEAR("ab" c*) -de', 'AND')).toBe('"near"* AND "ab"* AND "de"*')
    expect(toFtsQuery('   ', 'OR')).toBeNull()
    expect(toFtsQuery('Q3 plan', 'OR')).toBe('"q3"* OR "plan"*')
  })
})

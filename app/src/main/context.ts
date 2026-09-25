// Composition root for main-process state: the database, repositories and the
// event channel to renderers. Services receive this instead of importing
// singletons, which keeps them constructible in tests.
import type { Events } from '@shared/ipc'
import type { Attendee } from '@shared/types'
import { Db } from './db/database'
import { NotesRepo } from './db/notes'
import {
  CatalogRepo,
  ChatRepo,
  FoldersRepo,
  PeopleRepo,
  SearchRepo,
  SettingsRepo,
  StatsRepo,
  TranscriptRepo,
  type SecretBox,
} from './db/repos'

export type Emit = <E extends keyof Events>(event: E, payload: Events[E]) => void

export class AppContext {
  readonly notes: NotesRepo
  readonly transcripts: TranscriptRepo
  readonly folders: FoldersRepo
  readonly people: PeopleRepo
  readonly chats: ChatRepo
  readonly catalog: CatalogRepo
  readonly settings: SettingsRepo
  readonly search: SearchRepo
  readonly stats: StatsRepo

  constructor(
    readonly db: Db,
    readonly emit: Emit,
    readonly log: (message: string) => void = (message) => console.log(`[granola] ${message}`),
    secrets?: SecretBox,
  ) {
    this.notes = new NotesRepo(db)
    this.transcripts = new TranscriptRepo(db)
    this.folders = new FoldersRepo(db)
    this.people = new PeopleRepo(db)
    this.chats = new ChatRepo(db)
    this.catalog = new CatalogRepo(db)
    this.settings = new SettingsRepo(db, secrets)
    this.search = new SearchRepo(db)
    this.stats = new StatsRepo(db)
  }

  /** The user as a meeting attendee, from their profile. */
  self(): Attendee {
    const { name, email } = this.settings.get().profile
    return { name: name || 'Me', email: email ? email.toLowerCase() : null, isSelf: true }
  }
}

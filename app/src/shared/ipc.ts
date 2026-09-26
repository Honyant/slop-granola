// The single source of truth for main <-> renderer communication.
//
// `Api` is implemented by the main process (see main/ipc.ts) and consumed by the
// renderer through the preload bridge as `RendererApi` (every method async).
// Channel names are derived mechanically ("<namespace>:<method>"), so adding a
// method here is the only step needed to expose it — the compiler then forces
// the main process to implement it.
import type {
  CalendarEvent,
  CalendarInfo,
  ChatThread,
  CompanyRow,
  DocJSON,
  Folder,
  InputDevice,
  MeetingPrompt,
  Note,
  NoteSummary,
  Permissions,
  PersonRow,
  PromptAction,
  Recipe,
  RecordingState,
  SearchHit,
  Template,
  UsageStats,
  TranscriptSegment,
  Visibility,
} from './types'
import type { Settings, SettingsPatch } from './settings'
import type { Route } from './routes'

export interface NotePatch {
  title?: string
  doc?: DocJSON
  enhanced?: string | null
  view?: Note['view']
  visibility?: Visibility
  templateId?: string | null
}

export interface ChatSendInput {
  threadId: string | null
  text: string
  /** Scope the answer to one note (note page composer) or search all notes. */
  noteId: string | null
  recipeId: string | null
}

export interface Api {
  notes: {
    list(): NoteSummary[]
    listInFolder(folderId: string): NoteSummary[]
    get(id: string): Note | null
    /** Creating a note for an event that already has one returns the existing note. */
    create(input: { event?: CalendarEvent; folderId?: string }): Note
    update(id: string, patch: NotePatch): void
    trash(ids: string[]): void
    setFolder(noteIds: string[], folderId: string, member: boolean): void
    transcript(id: string): TranscriptSegment[]
    enhance(id: string): void
    copyLink(id: string): string
    search(query: string): SearchHit[]
    stats(): UsageStats
    /** Asks for a Granola transcript export (.txt) and imports its meetings; null if cancelled. */
    /** A generation in progress (or the last one's failure), so a reopened note can resume showing it. */
    enhanceState(id: string): Events['enhance:progress'] | null
    importGranola(): { imported: number; skipped: number } | null
  }
  folders: {
    list(): Folder[]
    create(name: string): Folder
    rename(id: string, name: string): void
    remove(id: string): void
  }
  people: {
    list(): PersonRow[]
    companies(): CompanyRow[]
  }
  recording: {
    start(noteId: string): void
    stop(): void
    setPaused(paused: boolean): void
    state(): RecordingState | null
    setMicDevice(uid: string | null): void
  }
  audio: {
    devices(): InputDevice[]
  }
  dictation: {
    start(): void
    stop(): void
  }
  calendar: {
    calendars(): CalendarInfo[]
    events(fromIso: string, toIso: string): CalendarEvent[]
  }
  chat: {
    send(input: ChatSendInput): { threadId: string; messageId: string }
    thread(id: string): ChatThread | null
    threads(): Omit<ChatThread, 'messages'>[]
    cancel(messageId: string): void
  }
  recipes: {
    list(): Recipe[]
  }
  templates: {
    list(): Template[]
  }
  settings: {
    get(): Settings
    update(patch: SettingsPatch): Settings
    testTranscription(): { ok: boolean; detail: string }
    testLlm(): { ok: boolean; detail: string }
  }
  system: {
    permissions(): Permissions
    requestPermission(kind: keyof Permissions): Permissions
    openExternal(url: string): void
    copy(text: string): void
    /** Native open dialog; resolves to the chosen path or null. */
    chooseFile(title: string, extensions: string[]): string | null
    openPrivacySettings(kind: keyof Permissions): void
    version(): string
  }
  overlay: {
    setExpanded(expanded: boolean): void
    focusMain(): void
  }
  prompt: {
    current(): MeetingPrompt | null
    act(id: string, action: PromptAction): void
    /** The prompt window sizes itself to its content (the options row expands it). */
    resize(height: number): void
  }
}

/** Events pushed from main to renderer(s). */
export interface Events {
  'notes:changed': { ids: string[] | 'all' }
  'folders:changed': null
  'recording:state': RecordingState | null
  /** Upsert by id: an interim is later replaced by the final with the same id. */
  'transcript:segment': TranscriptSegment
  /** A shown segment turned out to be echo of the other side and is withdrawn. */
  'transcript:removed': { noteId: string; id: string }
  'calendar:changed': null
  'chat:message': { threadId: string; messageId: string; content: string; status: 'streaming' | 'done' | 'error' }
  'enhance:progress': { noteId: string; markdown: string; status: 'streaming' | 'done' | 'error'; error?: string }
  'settings:changed': Settings
  navigate: Route
  'prompt:changed': MeetingPrompt | null
  /** Voice-input text; `done` marks the end of a dictation session. */
  'dictation:text': { text: string; final: boolean; done?: boolean; error?: string }
  /** Menu/shortcut commands the renderer handles. */
  command: 'toggleSidebar' | 'search'
}

type AnyFn = (...args: never[]) => unknown

export type Implementation<T> = {
  [K in keyof T]: T[K] extends AnyFn ? (...args: Parameters<T[K]>) => ReturnType<T[K]> | Promise<ReturnType<T[K]>> : Implementation<T[K]>
}

export type Async<T> = {
  [K in keyof T]: T[K] extends AnyFn ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> : Async<T[K]>
}

export type RendererApi = Async<Api>

export interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): () => void
}

export const channel = (namespace: string, method: string): string => `${namespace}:${method}`

/**
 * Builds the typed client from the untyped bridge. The namespace list is
 * the one runtime artefact of the contract; `satisfies` makes the compiler
 * reject a namespace that is missing or misspelled.
 */
const NAMESPACES = {
  notes: true,
  folders: true,
  people: true,
  recording: true,
  audio: true,
  dictation: true,
  calendar: true,
  chat: true,
  recipes: true,
  templates: true,
  settings: true,
  system: true,
  overlay: true,
  prompt: true,
} as const satisfies Record<keyof Api, true>

export function createClient(bridge: Bridge): RendererApi {
  const client: Record<string, unknown> = {}
  for (const ns of Object.keys(NAMESPACES)) {
    client[ns] = new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (...args: unknown[]) =>
            bridge.invoke(channel(ns, method), ...args),
      },
    )
  }
  return client as RendererApi
}

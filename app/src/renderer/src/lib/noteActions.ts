// Note mutations shared by list rows, the selection bar, calendar events and
// the note page. Each reports failures as a toast rather than throwing into React.
import type { CalendarEvent, Visibility } from '@shared/types'
import { api, errorMessage } from './api'
import { navigate } from './router'
import { useUi } from './ui'

const toast = (text: string) => useUi.getState().showToast(text)

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error) {
    toast(errorMessage(error))
    return undefined
  }
}

export const noteActions = {
  /** New ad-hoc note; Granola starts transcribing immediately. */
  async createAndRecord(): Promise<void> {
    const note = await attempt(() => api.notes.create({}))
    if (!note) return
    navigate({ name: 'note', id: note.id })
    await attempt(() => api.recording.start(note.id))
  },

  /** Opens (creating if needed) the note for a calendar event; records if the meeting is live. */
  async openEvent(event: CalendarEvent, now = Date.now()): Promise<void> {
    const note = await attempt(() => api.notes.create({ event }))
    if (!note) return
    navigate({ name: 'note', id: note.id })
    const live = Date.parse(event.start) - 5 * 60_000 <= now && now < Date.parse(event.end)
    if (live && !note.hasTranscript) await attempt(() => api.recording.start(note.id))
  },

  async noteForEvent(event: CalendarEvent): Promise<string | undefined> {
    return (await attempt(() => api.notes.create({ event })))?.id
  },

  setFolder: (ids: string[], folderId: string, member: boolean) => attempt(() => api.notes.setFolder(ids, folderId, member)),

  async setVisibility(ids: string[], visibility: Visibility): Promise<void> {
    await attempt(() => Promise.all(ids.map((id) => api.notes.update(id, { visibility }))))
  },

  async createFolder(ids: string[], name: string): Promise<void> {
    const folder = await attempt(() => api.folders.create(name))
    if (folder && ids.length) await attempt(() => api.notes.setFolder(ids, folder.id, true))
    if (folder) toast(`Added to ${folder.name}`)
  },

  async trash(ids: string[]): Promise<void> {
    await attempt(() => api.notes.trash(ids))
    toast(ids.length === 1 ? 'Moved to trash' : `Moved ${ids.length} notes to trash`)
  },

  async copyLink(id: string): Promise<void> {
    if (await attempt(() => api.notes.copyLink(id))) toast('Link copied')
  },
}

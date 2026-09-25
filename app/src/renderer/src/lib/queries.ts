// Data access for views. TanStack Query caches main-process reads; main-process
// events invalidate exactly the queries they affect, so views never poll.
import { QueryClient, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { create } from 'zustand'
import type { RecordingState, TranscriptSegment } from '@shared/types'
import { api, useEvent } from './api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
})

export const keys = {
  notes: ['notes'] as const,
  note: (id: string) => ['note', id] as const,
  folderNotes: (id: string) => ['folderNotes', id] as const,
  transcript: (id: string) => ['transcript', id] as const,
  folders: ['folders'] as const,
  people: ['people'] as const,
  companies: ['companies'] as const,
  settings: ['settings'] as const,
  recipes: ['recipes'] as const,
  templates: ['templates'] as const,
  calendars: ['calendars'] as const,
  events: (from: string, to: string) => ['events', from, to] as const,
  thread: (id: string) => ['thread', id] as const,
  threads: ['threads'] as const,
  devices: ['devices'] as const,
  permissions: ['permissions'] as const,
}

/** Wires main-process change events to cache invalidation. Mount once at the root. */
export function useLiveInvalidation(): void {
  useEvent('notes:changed', ({ ids }) => {
    void queryClient.invalidateQueries({ queryKey: keys.notes })
    void queryClient.invalidateQueries({ queryKey: ['folderNotes'] })
    void queryClient.invalidateQueries({ queryKey: keys.people })
    void queryClient.invalidateQueries({ queryKey: keys.companies })
    if (ids === 'all') {
      void queryClient.invalidateQueries({ queryKey: ['note'] })
      void queryClient.invalidateQueries({ queryKey: ['transcript'] })
    } else {
      for (const id of ids) {
        void queryClient.invalidateQueries({ queryKey: keys.note(id) })
        void queryClient.invalidateQueries({ queryKey: keys.transcript(id) })
      }
    }
  })
  useEvent('folders:changed', () => void queryClient.invalidateQueries({ queryKey: keys.folders }))
  useEvent('calendar:changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['events'] })
    void queryClient.invalidateQueries({ queryKey: keys.calendars })
  })
  useEvent('settings:changed', (settings) => queryClient.setQueryData(keys.settings, settings))
  // Streaming deltas are rendered from the event itself; refetch only on completion.
  useEvent('chat:message', ({ threadId, status }) => {
    if (status === 'streaming') return
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) })
    void queryClient.invalidateQueries({ queryKey: keys.threads })
  })
}

export const useNotes = () => useQuery({ queryKey: keys.notes, queryFn: () => api.notes.list() })
export const useNote = (id: string) => useQuery({ queryKey: keys.note(id), queryFn: () => api.notes.get(id) })
export const useFolderNotes = (id: string) => useQuery({ queryKey: keys.folderNotes(id), queryFn: () => api.notes.listInFolder(id) })
export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: () => api.folders.list() })
export const usePeople = () => useQuery({ queryKey: keys.people, queryFn: () => api.people.list() })
export const useCompanies = () => useQuery({ queryKey: keys.companies, queryFn: () => api.people.companies() })
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api.settings.get() })
export const useRecipes = () => useQuery({ queryKey: keys.recipes, queryFn: () => api.recipes.list() })
export const useTemplates = () => useQuery({ queryKey: keys.templates, queryFn: () => api.templates.list() })
export const useCalendars = () => useQuery({ queryKey: keys.calendars, queryFn: () => api.calendar.calendars() })
export const useCalendarEvents = (from: string, to: string) =>
  useQuery({ queryKey: keys.events(from, to), queryFn: () => api.calendar.events(from, to), staleTime: 60_000 })
export const useThread = (id: string | null) =>
  useQuery({ queryKey: keys.thread(id ?? ''), queryFn: () => api.chat.thread(id!), enabled: id !== null })
export const useDevices = () => useQuery({ queryKey: keys.devices, queryFn: () => api.audio.devices(), staleTime: 10_000 })
export const usePermissions = () => useQuery({ queryKey: keys.permissions, queryFn: () => api.system.permissions(), staleTime: 0 })

/** Current recording state, pushed from main at up to 10 Hz; one subscription app-wide. */
export const useRecording = create<{ state: RecordingState | null }>(() => ({ state: null }))
export const useRecordingState = (): RecordingState | null => useRecording((s) => s.state)

export function startRecordingSync(): void {
  void api.recording.state().then((state) => useRecording.setState({ state }))
  window.granola.on('recording:state', (state) => useRecording.setState({ state }))
}

/**
 * A note's transcript: persisted finals plus live interims/finals from the
 * active recording, upserted by segment id and kept in time order.
 *
 * Live segments only exist while this hook is mounted, so the stored part is
 * refetched on every mount: finals that arrived while the user was on another
 * page are in the database, not in any component's state.
 */
export function useTranscript(noteId: string): TranscriptSegment[] {
  const stored = useQuery({
    queryKey: keys.transcript(noteId),
    queryFn: () => api.notes.transcript(noteId),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const [live, setLive] = useState<Map<string, TranscriptSegment>>(() => new Map())
  useEvent('transcript:segment', (segment) => {
    if (segment.noteId !== noteId) return
    setLive((prev) => new Map(prev).set(segment.id, segment))
  })
  useEvent('transcript:removed', ({ noteId: target, id }) => {
    if (target !== noteId) return
    setLive((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  })
  const merged = new Map<string, TranscriptSegment>()
  for (const s of stored.data ?? []) merged.set(s.id, s)
  for (const [id, s] of live) merged.set(id, s)
  return [...merged.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

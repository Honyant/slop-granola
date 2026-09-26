import { useCallback, useEffect, useRef, useState } from 'react'
import { Calendar, Ellipsis, FolderPlus, Sparkles, Users } from 'lucide-react'
import { docToMarkdown, EMPTY_DOC, markdownToEditorHtml } from '@shared/doc'
import { dayHeading } from '@shared/time'
import { counterparty } from '@shared/speakers'
import type { Events, NotePatch } from '@shared/ipc'
import type { DocJSON, Note } from '@shared/types'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/controls'
import { FolderPicker } from '@/components/FolderPicker'
import { Markdown } from '@/components/Markdown'
import { MenuItem, MenuSeparator, Popover } from '@/components/Popover'
import { api, useEvent } from '@/lib/api'
import { noteActions } from '@/lib/noteActions'
import { useNote, useRecordingState, useTemplates, useTranscript } from '@/lib/queries'
import { navigate, useRouter } from '@/lib/router'
import { useDebouncedPatch } from '@/lib/useDebounced'
import { useUi } from '@/lib/ui'
import { TopBarActions } from '@/shell/TopBar'
import { NoteEditor } from './NoteEditor'
import { RecordingDock } from './RecordingDock'
import { TranscriptDocument } from './TranscriptDocument'
import styles from './NoteView.module.css'

const SAVE_DELAY_MS = 400

interface EnhanceState {
  markdown: string
  error?: string
  done?: boolean
}

export function NoteView({ id }: { id: string }) {
  const { data: note, isLoading } = useNote(id)
  const back = useRouter((s) => s.back)

  useEffect(() => {
    if (!isLoading && note === null) back()
  }, [isLoading, note, back])

  if (!note) return null
  return <NotePage note={note} />
}

function NotePage({ note }: { note: Note }) {
  const recordingState = useRecordingState()
  const recording = recordingState?.noteId === note.id ? recordingState : null
  const segments = useTranscript(note.id)
  const templates = useTemplates().data ?? []
  const [enhance, setEnhance] = useState<EnhanceState | null>(null)
  // Starts at the note's stored preference; streaming flips it to the enhanced notes.
  // The transcript tab is a way of looking at the note, not a saved preference.
  const [view, setView] = useState<Note['view'] | 'transcript'>(note.view)

  const applyProgress = useCallback((progress: Events['enhance:progress']) => {
    if (progress.status === 'streaming') {
      setEnhance({ markdown: progress.markdown })
      setView('enhanced')
    } else if (progress.status === 'done') {
      setEnhance({ markdown: progress.markdown, done: true })
    } else {
      // Surface failures where the result would have appeared.
      setEnhance({
        markdown: progress.markdown,
        error: progress.error ?? 'Enhancement failed',
      })
      setView('enhanced')
    }
  }, [])
  // Generation continues in the main process while the note is closed; pick it up on reopen.
  // A live event may arrive before that answer does, and it is newer.
  const receivedLive = useRef(false)
  useEvent('enhance:progress', (progress) => {
    if (progress.noteId !== note.id) return
    receivedLive.current = true
    applyProgress(progress)
  })
  useEffect(() => {
    void api.notes.enhanceState(note.id).then((progress) => {
      if (progress && !receivedLive.current) applyProgress(progress)
    })
  }, [note.id, applyProgress])

  const save = useDebouncedPatch<NotePatch>((patch) => void api.notes.update(note.id, patch), SAVE_DELAY_MS)
  const enhancing = enhance !== null && !enhance.error && !enhance.done

  // Keep showing the streamed result until the saved note has caught up, so the
  // editor (uncontrolled) mounts with the final text rather than stale content.
  useEffect(() => {
    if (enhance?.done && note.enhanced === enhance.markdown) setEnhance(null)
  }, [enhance, note.enhanced])

  const runEnhance = () => {
    setEnhance({ markdown: '' })
    setView('enhanced')
    void api.notes.enhance(note.id)
  }

  const chooseView = (next: Note['view'] | 'transcript') => {
    setView(next)
    if (next !== 'transcript') void api.notes.update(note.id, { view: next })
  }

  const hasEnhanced = note.enhanced !== null || enhance !== null
  const hasTranscript = segments.length > 0 || recording !== null
  const tab = view === 'enhanced' && !hasEnhanced ? 'mine' : view === 'transcript' && !hasTranscript ? 'mine' : view

  return (
    <>
      <TopBarActions>
        {(hasEnhanced || hasTranscript) && (
          <div className={styles.segmented} role="tablist">
            {hasEnhanced && (
              <button type="button" role="tab" aria-selected={tab === 'enhanced'} onClick={() => chooseView('enhanced')}>
                <Sparkles size={13} strokeWidth={1.8} /> Enhanced
              </button>
            )}
            <button type="button" role="tab" aria-selected={tab === 'mine'} onClick={() => chooseView('mine')}>
              My notes
            </button>
            {hasTranscript && (
              <button type="button" role="tab" aria-selected={tab === 'transcript'} onClick={() => chooseView('transcript')}>
                Transcript
              </button>
            )}
          </div>
        )}
        <NoteMenu note={note} onEnhance={runEnhance} canEnhance={segments.length > 0 || docToMarkdown(note.doc) !== ''} />
      </TopBarActions>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <TitleInput note={note} onChange={(title) => save({ title })} />
          <MetaRow note={note} />
          {tab === 'transcript' ? (
            <TranscriptDocument segments={segments} live={recording !== null} counterparty={counterparty(note.attendees)} />
          ) : tab === 'enhanced' ? (
            <EnhancedNotes
              key={enhance ? 'streaming' : 'stored'}
              note={note}
              streaming={enhance}
              onChange={(enhanced) => save({ enhanced })}
              onRetry={runEnhance}
            />
          ) : (
            <NoteEditor
              content={isEmptyDoc(note.doc) ? EMPTY_DOC : note.doc}
              placeholder="Write notes, or press '/' for templates"
              templates={templates}
              onTemplate={(t) => void api.notes.update(note.id, { templateId: t.id })}
              onChange={(doc) => save({ doc })}
            />
          )}
        </div>
      </div>
      <RecordingDock note={note} segments={segments} recording={recording} enhancing={enhancing} onEnhance={runEnhance} />
    </>
  )
}

function TitleInput({ note, onChange }: { note: Note; onChange(title: string): void }) {
  const [title, setTitle] = useState(note.title)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Adopt titles generated in the background (enhancement) unless the user is typing.
  useEffect(() => {
    if (document.activeElement !== ref.current) setTitle(note.title)
  }, [note.title])
  return (
    <textarea
      ref={ref}
      className={`${styles.title} display`}
      rows={1}
      value={title}
      placeholder="New note"
      spellCheck={false}
      onChange={(e) => {
        const next = e.target.value.replace(/\n/g, ' ')
        setTitle(next)
        onChange(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          document.querySelector<HTMLElement>('.ProseMirror')?.focus()
        }
      }}
    />
  )
}

function MetaRow({ note }: { note: Note }) {
  const peopleAnchor = useRef<HTMLButtonElement>(null)
  const folderAnchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'people' | 'folder' | null>(null)
  const others = note.attendees.filter((a) => !a.isSelf)
  const who =
    others.length === 0 ? 'Me' : others.length <= 2 ? others.map((a) => a.name.split(/\s+/)[0]).join(', ') : `${others.length + 1} people`

  return (
    <div className={styles.meta}>
      <button ref={peopleAnchor} type="button" className={styles.metaPill} onClick={() => setOpen(open === 'people' ? null : 'people')}>
        <span className={styles.metaPart}>
          <Calendar size={15} strokeWidth={1.6} />
          {dayHeading(note.meetingAt, Date.now())}
        </span>
        <span className={styles.metaPart}>
          <Users size={15} strokeWidth={1.6} />
          {who}
        </span>
      </button>
      <IconButton
        ref={folderAnchor}
        label="Add to folder"
        size={27}
        className={styles.folderButton}
        onClick={() => setOpen(open === 'folder' ? null : 'folder')}
      >
        <FolderPlus size={15} strokeWidth={1.6} />
      </IconButton>
      <Popover anchor={peopleAnchor} open={open === 'people'} onClose={() => setOpen(null)} className={styles.people}>
        <div className={styles.peopleHeading}>
          {new Date(note.meetingAt).toLocaleString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
        {note.attendees.map((a) => (
          <MenuItem
            key={`${a.email}-${a.name}`}
            icon={<Avatar name={a.name} seed={a.email ?? a.name} size={18} />}
            trailing={a.isSelf ? 'You' : undefined}
            onSelect={() => {
              setOpen(null)
              if (a.email) navigate({ name: 'person', email: a.email })
            }}
          >
            {a.name}
          </MenuItem>
        ))}
      </Popover>
      <FolderPicker
        anchor={folderAnchor}
        open={open === 'folder'}
        onClose={() => setOpen(null)}
        folderIds={note.folderIds}
        visibility={note.visibility}
        onToggleFolder={(folderId, member) => void noteActions.setFolder([note.id], folderId, member)}
        onSetVisibility={(v) => void noteActions.setVisibility([note.id], v)}
        onCreateFolder={(name) => void noteActions.createFolder([note.id], name)}
      />
    </div>
  )
}

function EnhancedNotes(props: { note: Note; streaming: EnhanceState | null; onChange(markdown: string): void; onRetry(): void }) {
  const { note, streaming } = props
  // Parsed once per mount: the editor is uncontrolled afterwards (remounted via `key`).
  const [html] = useState(() => markdownToEditorHtml(note.enhanced ?? ''))

  if (streaming) {
    return (
      <div className={styles.enhanced}>
        {streaming.error ? (
          <div className={styles.enhanceError}>
            <span>{streaming.error}</span>
            <button type="button" onClick={props.onRetry}>
              Try again
            </button>
            <button type="button" onClick={() => navigate({ name: 'settings', section: 'connectors' })}>
              Settings
            </button>
          </div>
        ) : (
          !streaming.done && (
            <div className={styles.enhancing}>
              <Sparkles size={14} strokeWidth={1.8} /> Enhancing notes…
            </div>
          )
        )}
        {streaming.markdown && <Markdown>{streaming.markdown}</Markdown>}
      </div>
    )
  }
  return (
    <div className={styles.enhanced}>
      <NoteEditor content={html} placeholder="" onChange={(doc: DocJSON) => props.onChange(docToMarkdown(doc))} />
    </div>
  )
}

function NoteMenu({ note, onEnhance, canEnhance }: { note: Note; onEnhance(): void; canEnhance: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const back = useRouter((s) => s.back)
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <>
      <IconButton ref={anchor} label="Note options" onClick={() => setOpen((o) => !o)}>
        <Ellipsis size={17} strokeWidth={1.8} />
      </IconButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" className={styles.menu}>
        <MenuItem disabled={!canEnhance} onSelect={run(onEnhance)}>
          {note.enhanced ? 'Regenerate notes' : 'Generate notes'}
        </MenuItem>
        <MenuItem onSelect={run(() => void noteActions.copyLink(note.id))}>Copy link</MenuItem>
        <MenuItem
          onSelect={run(() => {
            void api.system.copy(note.enhanced ?? docToMarkdown(note.doc))
            useUi.getState().showToast('Notes copied')
          })}
        >
          Copy notes
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          onSelect={run(() => {
            void noteActions.trash([note.id])
            back()
          })}
        >
          Move to trash
        </MenuItem>
      </Popover>
    </>
  )
}

function isEmptyDoc(doc: DocJSON): boolean {
  return !doc.content || doc.content.length === 0
}

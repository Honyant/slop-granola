import { useRef, useState } from 'react'
import { Check, ChevronDown, Ellipsis, File, Lock, Users } from 'lucide-react'
import { dayHeading, startOfDay } from '@shared/time'
import type { NoteSummary, Visibility } from '@shared/types'
import { noteActions } from '@/lib/noteActions'
import { navigate } from '@/lib/router'
import { useSettings } from '@/lib/queries'
import { Avatar } from './Avatar'
import { DancingBars } from './DancingBars'
import { FolderPicker } from './FolderPicker'
import { MenuItem, Popover } from './Popover'
import { Time } from './Time'
import styles from './NoteList.module.css'

interface NoteListProps {
  notes: NoteSummary[]
  now: number
  selected: ReadonlySet<string>
  onToggleSelected(id: string): void
}

/** Notes grouped by meeting day, newest first (Granola's home list). */
export function NoteList({ notes, now, selected, onToggleSelected }: NoteListProps) {
  const groups: { day: number; notes: NoteSummary[] }[] = []
  for (const note of notes) {
    const day = startOfDay(note.meetingAt)
    const group = groups.at(-1)
    if (group?.day === day) group.notes.push(note)
    else groups.push({ day, notes: [note] })
  }
  const selecting = selected.size > 0

  return (
    <div className={styles.list} data-selecting={selecting || undefined}>
      {groups.map((group) => (
        <section key={group.day} className={styles.group}>
          <h2 className={styles.heading}>{dayHeading(group.day, now)}</h2>
          {group.notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              selected={selected.has(note.id)}
              selecting={selecting}
              onToggleSelected={() => onToggleSelected(note.id)}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

interface NoteRowProps {
  note: NoteSummary
  selected: boolean
  selecting: boolean
  onToggleSelected(): void
}

function NoteRow({ note, selected, selecting, onToggleSelected }: NoteRowProps) {
  const others = note.attendees.filter((a) => !a.isSelf)
  const lead = others[0]
  const subtitle = others.length ? others.map((a) => a.name.split(/\s+/)[0]).join(', ') : 'Me'
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const visibilityAnchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'menu' | 'folder' | 'visibility' | null>(null)
  const closeThen = (action: () => Promise<unknown>) => () => {
    setOpen(null)
    void action()
  }

  return (
    <div className={styles.row} data-selected={selected || undefined} data-open={open !== null || undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${note.title || 'note'}`}
        className={styles.checkbox}
        onClick={onToggleSelected}
      >
        {selected && <Check size={11} strokeWidth={3} />}
      </button>
      <button
        type="button"
        className={styles.main}
        onClick={() => (selecting ? onToggleSelected() : navigate({ name: 'note', id: note.id }))}
      >
        {lead ? (
          <Avatar name={lead.name} seed={lead.email ?? lead.name} size={28} shape="square" />
        ) : (
          <span className={styles.docIcon}>
            <File size={15} strokeWidth={1.7} />
          </span>
        )}
        <span className={styles.text}>
          <span className={styles.title}>{note.title || 'New note'}</span>
          <span className={styles.subtitle}>{subtitle}</span>
        </span>
      </button>
      <span className={styles.meta}>{note.isRecording ? <DancingBars level={0.5} size={12} /> : <Time ms={note.meetingAt} />}</span>
      <span className={styles.actions}>
        <button
          ref={visibilityAnchor}
          type="button"
          className={styles.visibility}
          onClick={() => setOpen(open === 'visibility' ? null : 'visibility')}
        >
          {note.visibility === 'private' ? <Lock size={12} strokeWidth={2} /> : <Users size={13} strokeWidth={1.8} />}
          {note.visibility === 'private' ? 'Private' : 'Workspace'}
          <ChevronDown size={13} strokeWidth={1.8} />
        </button>
        <button
          ref={menuAnchor}
          type="button"
          className={styles.more}
          aria-label="More"
          onClick={() => setOpen(open === 'menu' ? null : 'menu')}
        >
          <Ellipsis size={16} strokeWidth={1.8} />
        </button>
      </span>

      <VisibilityMenu
        anchor={visibilityAnchor}
        open={open === 'visibility'}
        value={note.visibility}
        onClose={() => setOpen(null)}
        onChange={(v) => void noteActions.setVisibility([note.id], v)}
      />
      <Popover anchor={menuAnchor} open={open === 'menu'} onClose={() => setOpen(null)} placement="bottom-end" className={styles.menu}>
        <MenuItem onSelect={closeThen(() => noteActions.copyLink(note.id))}>Copy link</MenuItem>
        <MenuItem onSelect={closeThen(() => noteActions.copyLink(note.id))}>Share</MenuItem>
        <MenuItem onSelect={() => setOpen('folder')}>Add to folder</MenuItem>
        <MenuItem danger onSelect={closeThen(() => noteActions.trash([note.id]))}>
          Move to trash
        </MenuItem>
      </Popover>
      <FolderPicker
        anchor={menuAnchor}
        open={open === 'folder'}
        onClose={() => setOpen(null)}
        placement="bottom-end"
        folderIds={note.folderIds}
        visibility={note.visibility}
        onToggleFolder={(folderId, member) => void noteActions.setFolder([note.id], folderId, member)}
        onSetVisibility={(v) => void noteActions.setVisibility([note.id], v)}
        onCreateFolder={(name) => void noteActions.createFolder([note.id], name)}
      />
    </div>
  )
}

export function VisibilityMenu(props: {
  anchor: React.RefObject<HTMLElement | null>
  open: boolean
  value: Visibility
  onClose(): void
  onChange(value: Visibility): void
}) {
  const workspace = useSettings().data?.workspace.name ?? 'Workspace'
  const choose = (value: Visibility) => {
    props.onClose()
    props.onChange(value)
  }
  return (
    <Popover anchor={props.anchor} open={props.open} onClose={props.onClose} placement="bottom-end">
      <MenuItem icon={<Lock size={14} />} trailing={props.value === 'private' && <Check size={14} />} onSelect={() => choose('private')}>
        Private
      </MenuItem>
      <MenuItem
        icon={<Users size={14} />}
        trailing={props.value === 'workspace' && <Check size={14} />}
        onSelect={() => choose('workspace')}
      >
        Anyone in {workspace}
      </MenuItem>
    </Popover>
  )
}

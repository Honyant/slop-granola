import { useEffect, useRef, useState } from 'react'
import { Ellipsis, FolderClosed, Plus, UserPlus, X } from 'lucide-react'
import { AskBar } from '@/components/AskBar'
import { Button } from '@/components/controls'
import { FolderPicker } from '@/components/FolderPicker'
import { NoteList } from '@/components/NoteList'
import { MenuItem, Popover } from '@/components/Popover'
import { useNow } from '@/lib/useNow'
import { noteActions } from '@/lib/noteActions'
import { useNotes } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { TopBarActions } from '@/shell/TopBar'
import { ComingUp } from './ComingUp'
import page from '../page.module.css'
import styles from './HomeView.module.css'

export function HomeView() {
  const now = useNow()
  const notes = useNotes().data
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  // Drop selections of notes that disappeared (trashed elsewhere).
  useEffect(() => {
    if (!notes || selected.size === 0) return
    const ids = new Set(notes.map((n) => n.id))
    if ([...selected].some((id) => !ids.has(id))) setSelected(new Set([...selected].filter((id) => ids.has(id))))
  }, [notes, selected])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <>
      <TopBarActions>
        <Button icon={<UserPlus size={15} strokeWidth={1.7} />} onClick={() => navigate({ name: 'settings', section: 'members' })}>
          Invite
        </Button>
        <Button icon={<Plus size={15} strokeWidth={1.7} />} onClick={() => void noteActions.createAndRecord()}>
          New note
        </Button>
      </TopBarActions>
      <div className={page.scroll}>
        <div className={page.column}>
          <ComingUp now={now} />
          {notes && notes.length > 0 && <NoteList notes={notes} now={now} selected={selected} onToggleSelected={toggle} />}
          {notes && notes.length === 0 && (
            <div className={styles.empty}>
              <p>Your notes will show up here.</p>
              <p>Start one with “New note”, or open an event above when a meeting begins.</p>
            </div>
          )}
        </div>
      </div>
      {selected.size > 0 && <SelectionBar ids={[...selected]} onClear={() => setSelected(new Set())} />}
      <AskBar noteId={null} />
    </>
  )
}

function SelectionBar({ ids, onClear }: { ids: string[]; onClear(): void }) {
  const folderAnchor = useRef<HTMLButtonElement>(null)
  const moreAnchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'folder' | 'more' | null>(null)
  return (
    <div className={styles.selection} role="toolbar" aria-label="Selected notes">
      <span className={styles.count}>{ids.length}</span>
      <span>selected</span>
      <button type="button" className={styles.clear} aria-label="Clear selection" onClick={onClear}>
        <X size={14} strokeWidth={1.8} />
      </button>
      <span className={styles.divider} />
      <button ref={folderAnchor} type="button" className={styles.action} onClick={() => setOpen(open === 'folder' ? null : 'folder')}>
        <FolderClosed size={15} strokeWidth={1.7} />
        Add to folder
      </button>
      <span className={styles.divider} />
      <button
        ref={moreAnchor}
        type="button"
        className={styles.action}
        aria-label="More"
        onClick={() => setOpen(open === 'more' ? null : 'more')}
      >
        <Ellipsis size={16} strokeWidth={1.8} />
      </button>
      <FolderPicker
        anchor={folderAnchor}
        open={open === 'folder'}
        onClose={() => setOpen(null)}
        placement="top-start"
        folderIds={[]}
        visibility="private"
        onToggleFolder={(folderId, member) => void noteActions.setFolder(ids, folderId, member)}
        onSetVisibility={(v) => void noteActions.setVisibility(ids, v)}
        onCreateFolder={(name) => void noteActions.createFolder(ids, name)}
      />
      <Popover anchor={moreAnchor} open={open === 'more'} onClose={() => setOpen(null)} placement="top-start" className={styles.moreMenu}>
        <MenuItem
          danger
          onSelect={() => {
            setOpen(null)
            onClear()
            void noteActions.trash(ids)
          }}
        >
          Move to trash
        </MenuItem>
      </Popover>
    </div>
  )
}

import { useRef, useState } from 'react'
import { Ellipsis, Folder, FolderPlus, Lock } from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { Button, IconButton } from '@/components/controls'
import { MenuItem, Popover } from '@/components/Popover'
import { NoteList } from '@/components/NoteList'
import { api } from '@/lib/api'
import { useFolderNotes, useFolders, useNotes, useSettings } from '@/lib/queries'
import { navigate, useRouter } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import { TopBarActions } from '@/shell/TopBar'
import page from './page.module.css'
import styles from './SpaceView.module.css'

/** A space (My notes / the workspace) with its folders and notes. */
export function SpaceView({ space }: { space: 'private' | 'workspace' }) {
  const now = useNow()
  const settings = useSettings().data
  const notes = (useNotes().data ?? []).filter((n) => n.visibility === space)
  const folders = useFolders().data ?? []
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const title = space === 'private' ? 'My notes' : (settings?.workspace.name ?? '')

  return (
    <>
      <TopBarActions>
        <NewFolderButton />
      </TopBarActions>
      <div className={page.scroll}>
        <div className={page.column}>
          <h1 className={`${page.heading} ${styles.title} display`}>
            {space === 'private' ? (
              <span className={styles.lockTile}>
                <Lock size={15} strokeWidth={2} />
              </span>
            ) : (
              <Avatar name={title} src={settings?.workspace.avatar} size={30} shape="square" />
            )}
            {title}
          </h1>
          {folders.length > 0 && (
            <div className={styles.folders}>
              {folders.map((f) => (
                <button key={f.id} type="button" className={styles.folder} onClick={() => navigate({ name: 'folder', id: f.id })}>
                  <Folder size={18} strokeWidth={0} fill="currentColor" className={styles.folderIcon} />
                  <span className={styles.folderName}>{f.name}</span>
                  <span className={styles.folderCount}>{f.noteCount}</span>
                </button>
              ))}
            </div>
          )}
          {notes.length > 0 ? (
            <NoteList
              notes={notes}
              now={now}
              selected={selected}
              onToggleSelected={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(id)) next.add(id)
                  return next
                })
              }
            />
          ) : (
            <p className={styles.empty}>
              {space === 'private'
                ? 'Private notes you take appear here.'
                : `Notes shared with ${title} appear here. Change a note from Private to share it.`}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

function NewFolderButton() {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button ref={anchor} icon={<FolderPlus size={15} strokeWidth={1.7} />} onClick={() => setOpen((o) => !o)}>
        New folder
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end">
        <form
          className={styles.newFolder}
          onSubmit={async (e) => {
            e.preventDefault()
            const name = new FormData(e.currentTarget).get('name')?.toString().trim()
            if (!name) return
            setOpen(false)
            const folder = await api.folders.create(name)
            navigate({ name: 'folder', id: folder.id })
          }}
        >
          <input autoFocus name="name" placeholder="Folder name" />
        </form>
      </Popover>
    </>
  )
}

export function FolderView({ id }: { id: string }) {
  const now = useNow()
  const folder = (useFolders().data ?? []).find((f) => f.id === id)
  const notes = useFolderNotes(id).data ?? []
  const back = useRouter((s) => s.back)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  if (!folder) return null

  return (
    <>
      <TopBarActions>
        <IconButton ref={menuAnchor} label="Folder options" onClick={() => setMenuOpen((o) => !o)}>
          <Ellipsis size={16} strokeWidth={1.8} />
        </IconButton>
        <Popover anchor={menuAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom-end">
          <MenuItem
            onSelect={() => {
              setMenuOpen(false)
              setRenaming(true)
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            danger
            onSelect={() => {
              setMenuOpen(false)
              void api.folders.remove(id).then(back)
            }}
          >
            Delete folder
          </MenuItem>
        </Popover>
      </TopBarActions>
      <div className={page.scroll}>
        <div className={page.column}>
          {renaming ? (
            <input
              autoFocus
              className={`${page.heading} ${styles.rename} display`}
              defaultValue={folder.name}
              onBlur={(e) => {
                setRenaming(false)
                void api.folders.rename(id, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
            />
          ) : (
            <h1 className={`${page.heading} display`} onDoubleClick={() => setRenaming(true)}>
              {folder.name}
            </h1>
          )}
          {notes.length > 0 ? (
            <NoteList
              notes={notes}
              now={now}
              selected={selected}
              onToggleSelected={(noteId) =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(noteId)) next.add(noteId)
                  return next
                })
              }
            />
          ) : (
            <p className={styles.empty}>No notes in this folder yet. Use “Add to folder” on any note.</p>
          )}
        </div>
      </div>
    </>
  )
}

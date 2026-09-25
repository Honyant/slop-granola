import { useState, type RefObject } from 'react'
import { Check, Folder, FolderPlus, Lock, Search } from 'lucide-react'
import type { Visibility } from '@shared/types'
import { useFolders, useSettings } from '@/lib/queries'
import { Avatar } from './Avatar'
import { Popover, type Placement } from './Popover'
import styles from './FolderPicker.module.css'

interface FolderPickerProps {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  placement?: Placement
  folderIds: string[]
  visibility: Visibility
  onToggleFolder(folderId: string, member: boolean): void
  onSetVisibility(visibility: Visibility): void
  onCreateFolder(name: string): void
}

/** "Add to folder": spaces (My notes / workspace) and folders, filterable. */
export function FolderPicker(props: FolderPickerProps) {
  const { anchor, open, onClose, placement = 'bottom-start', folderIds, visibility } = props
  const folders = useFolders().data ?? []
  const workspace = useSettings().data?.workspace
  const [query, setQuery] = useState('')
  const [naming, setNaming] = useState<string | null>(null)
  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase())

  const close = () => {
    setQuery('')
    setNaming(null)
    onClose()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} placement={placement} className={styles.picker}>
      <label className={styles.search}>
        <input autoFocus placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Search size={15} strokeWidth={1.7} />
      </label>
      <div className={styles.list}>
        {match('My notes') && (
          <button type="button" className={styles.row} onClick={() => props.onSetVisibility('private')}>
            <span className={styles.tile}>
              <Lock size={12} strokeWidth={2.2} />
            </span>
            <span className={styles.name}>My notes</span>
            {visibility === 'private' && <Check size={15} className={styles.check} />}
          </button>
        )}
        {folders
          .filter((f) => match(f.name))
          .map((folder) => {
            const member = folderIds.includes(folder.id)
            return (
              <button key={folder.id} type="button" className={styles.row} onClick={() => props.onToggleFolder(folder.id, !member)}>
                <span className={styles.folderIcon}>
                  <Folder size={17} strokeWidth={0} fill="currentColor" />
                </span>
                <span className={styles.name}>{folder.name}</span>
                {member ? <Check size={15} className={styles.check} /> : <span className={styles.count}>{folder.noteCount}</span>}
              </button>
            )
          })}
        {workspace && match(workspace.name) && (
          <button type="button" className={styles.row} onClick={() => props.onSetVisibility('workspace')}>
            <Avatar name={workspace.name} src={workspace.avatar} size={26} shape="square" />
            <span className={styles.name}>{workspace.name}</span>
            {visibility === 'workspace' && <Check size={15} className={styles.check} />}
          </button>
        )}
      </div>
      <div className={styles.footer}>
        {naming === null ? (
          <button type="button" className={styles.newFolder} onClick={() => setNaming(query)}>
            <FolderPlus size={16} strokeWidth={1.7} />
            New folder
          </button>
        ) : (
          <form
            className={styles.newForm}
            onSubmit={(e) => {
              e.preventDefault()
              if (naming.trim()) props.onCreateFolder(naming.trim())
              close()
            }}
          >
            <FolderPlus size={16} strokeWidth={1.7} />
            <input autoFocus placeholder="Folder name" value={naming} onChange={(e) => setNaming(e.target.value)} />
          </form>
        )}
      </div>
    </Popover>
  )
}

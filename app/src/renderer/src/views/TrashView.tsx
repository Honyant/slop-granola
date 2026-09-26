// Trashed notes. They stay here for 30 days (TRASH_RETENTION_MS in main/index.ts) before
// being deleted for good, and can be restored until then.
import { RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/controls'
import { api } from '@/lib/api'
import { useTrash } from '@/lib/queries'
import { useUi } from '@/lib/ui'
import page from './page.module.css'
import styles from './TrashView.module.css'

const RETENTION_DAYS = 30
const DAY_MS = 86_400_000

export function TrashView() {
  const notes = useTrash().data ?? []
  const showToast = useUi((s) => s.showToast)
  const restore = (ids: string[], title: string) => {
    void api.notes.restore(ids)
    showToast(`Restored ${title}`)
  }
  return (
    <div className={page.scroll}>
      <div className={page.column}>
        <div className={styles.header}>
          <h1 className={`${page.heading} display`}>Trash</h1>
          {notes.length > 0 && (
            <Button size="sm" onClick={() => void api.notes.deleteForever(notes.map((n) => n.id))}>
              Empty trash
            </Button>
          )}
        </div>
        <p className={styles.hint}>Notes in the trash are deleted for good after {RETENTION_DAYS} days.</p>
        {notes.length === 0 ? (
          <p className={styles.empty}>The trash is empty</p>
        ) : (
          <ul className={styles.list}>
            {notes.map((note) => {
              const title = note.title.trim() || 'New note'
              const daysLeft = Math.max(0, Math.ceil((note.trashedAt + RETENTION_DAYS * DAY_MS - Date.now()) / DAY_MS))
              return (
                <li key={note.id} className={styles.row}>
                  <span className={styles.text}>
                    <span className={styles.title}>{title}</span>
                    <span className={styles.meta}>
                      {new Date(note.meetingAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · deleted in {daysLeft}{' '}
                      {daysLeft === 1 ? 'day' : 'days'}
                    </span>
                  </span>
                  <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => restore([note.id], title)}>
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} />}
                    aria-label={`Delete ${title} forever`}
                    onClick={() => void api.notes.deleteForever([note.id])}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

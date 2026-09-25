import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Building2, ChevronLeft, FileText, Folder, House, Lock, MessageCircle, Settings, SquareSlash, User, Users, X } from 'lucide-react'
import type { Route } from '@shared/routes'
import { DancingBars } from '@/components/DancingBars'
import { api } from '@/lib/api'
import { useNote, useRecordingState } from '@/lib/queries'
import { navigate, usePreviousRoute, useRoute, useRouter } from '@/lib/router'
import styles from './TopBar.module.css'

const SLOT_ID = 'topbar-actions'

export function TopBar({ title, leftInset }: { title?: string; leftInset: number }) {
  const route = useRoute()
  const previous = usePreviousRoute()
  const back = useRouter((s) => s.back)
  const showBack = route.name !== 'home' && previous !== null

  return (
    <header className={`${styles.bar} drag`} style={{ paddingLeft: leftInset }}>
      <div className={styles.left}>
        {showBack && (
          <button type="button" className={`${styles.back} no-drag`} onClick={back} aria-label="Back">
            <ChevronLeft size={13} strokeWidth={2} />
            {routeIcon(previous)}
          </button>
        )}
      </div>
      <div className={styles.center}>
        <RecordingPill />
        {title && <span className={styles.title}>{title}</span>}
      </div>
      <div id={SLOT_ID} className={styles.right} />
    </header>
  )
}

/** Renders children into the top bar's right-hand slot. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => setTarget(document.getElementById(SLOT_ID)), [])
  return target ? createPortal(children, target) : null
}

function RecordingPill() {
  const recording = useRecordingState()
  const route = useRoute()
  const note = useNote(recording?.noteId ?? '').data
  if (!recording || (route.name === 'note' && route.id === recording.noteId)) return null
  const level = Math.max(recording.mic.level, recording.system.level)
  return (
    <div className={`${styles.pill} no-drag`}>
      <button type="button" className={styles.pillMain} onClick={() => navigate({ name: 'note', id: recording.noteId })}>
        <DancingBars level={level} active={!recording.paused} size={13} />
        <span className={styles.pillTitle}>{note?.title || 'New note'}</span>
      </button>
      <button type="button" className={styles.pillClose} aria-label="Stop recording" onClick={() => void api.recording.stop()}>
        <X size={15} strokeWidth={1.8} />
      </button>
    </div>
  )
}

function routeIcon(route: Route | null) {
  const props = { size: 15, strokeWidth: 1.7 }
  switch (route?.name) {
    case 'shared':
      return <Users {...props} />
    case 'chat':
      return <MessageCircle {...props} />
    case 'note':
      return <FileText {...props} />
    case 'people':
    case 'person':
      return <User {...props} />
    case 'companies':
    case 'company':
      return <Building2 {...props} />
    case 'recipes':
      return <SquareSlash {...props} />
    case 'settings':
      return <Settings {...props} />
    case 'folder':
      return <Folder {...props} />
    case 'space':
      return <Lock {...props} />
    default:
      return <House {...props} />
  }
}

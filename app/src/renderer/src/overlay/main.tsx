// The floating "nub" shown over other apps while recording.
import { Fragment, StrictMode, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { DancingBars } from '@/components/DancingBars'
import { Spiral } from '@/components/Spiral'
import { api } from '@/lib/api'
import { counterparty } from '@shared/speakers'
import { queryClient, startRecordingSync, useLiveInvalidation, useNote, useRecordingState, useTranscript } from '@/lib/queries'
import '../styles/global.css'
import styles from './Overlay.module.css'

function Overlay() {
  useLiveInvalidation()
  const recording = useRecordingState()
  const [expanded, setExpanded] = useState(false)
  if (!recording) return null
  const level = Math.max(recording.mic.level, recording.system.level)

  const toggle = () => {
    setExpanded(!expanded)
    void api.overlay.setExpanded(!expanded)
  }

  return (
    <div className={styles.root}>
      <div className={styles.nub}>
        <button type="button" className={styles.logo} aria-label="Open Granola" onClick={() => void api.overlay.focusMain()}>
          <Spiral size={20} strokeWidth={2.4} />
        </button>
        <button type="button" className={styles.bars} aria-label={expanded ? 'Hide transcript' : 'Show transcript'} onClick={toggle}>
          <DancingBars level={recording.paused ? 0 : level} active={!recording.paused} size={12} />
        </button>
      </div>
      {expanded && <LiveTranscript noteId={recording.noteId} />}
    </div>
  )
}

function LiveTranscript({ noteId }: { noteId: string }) {
  const segments = useTranscript(noteId).slice(-40)
  const them = counterparty(useNote(noteId).data?.attendees ?? [])
  const scroller = useRef<HTMLDivElement>(null)
  const lastText = segments.at(-1)?.text
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [segments.length, lastText])
  return (
    <div ref={scroller} className={styles.panel}>
      {segments.length === 0 && <p className={styles.empty}>Listening…</p>}
      {segments.map((s, i) => (
        <Fragment key={s.id}>
          {them && s.source === 'system' && segments[i - 1]?.source !== 'system' && <span className={styles.speaker}>{them}</span>}
          <div className={styles.bubble} data-source={s.source} data-final={s.final || undefined}>
            {s.text}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

startRecordingSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Overlay />
    </QueryClientProvider>
  </StrictMode>,
)

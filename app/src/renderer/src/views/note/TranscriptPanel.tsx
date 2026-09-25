import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, Minus, Search, ThumbsDown, X } from 'lucide-react'
import type { RecordingState, TranscriptSegment } from '@shared/types'
import { speakerLabel } from '@shared/speakers'
import { IconButton } from '@/components/controls'
import { api } from '@/lib/api'
import { Highlight } from '@/components/Highlight'
import { useUi } from '@/lib/ui'
import styles from './TranscriptPanel.module.css'

interface TranscriptPanelProps {
  segments: TranscriptSegment[]
  recording: RecordingState | null
  /** The one other person on the call, when there is exactly one. */
  counterparty: string | null
  footer: React.ReactNode
  onCollapse(): void
}

const CONSENT_URL = 'https://docs.granola.ai/help-center/consent'

export function TranscriptPanel({ segments, recording, counterparty, footer, onCollapse }: TranscriptPanelProps) {
  const showToast = useUi((s) => s.showToast)
  const [query, setQuery] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const q = query?.trim().toLowerCase() ?? ''
  const visible = q ? segments.filter((s) => s.text.toLowerCase().includes(q)) : segments

  // Follow new speech unless the user has scrolled up to read.
  const lastText = visible.at(-1)?.text
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [visible.length, lastText])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && query === null) onCollapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, onCollapse])

  const copyTranscript = () => {
    const text = segments
      .filter((s) => s.final)
      .map((s) => `${speakerLabel(s.source, counterparty)}: ${s.text}`)
      .join('\n')
    void api.system.copy(text)
    showToast('Transcript copied')
  }

  const copyDiagnostics = () => {
    const report = {
      recording: recording && {
        mic: recording.mic,
        system: recording.system,
        error: recording.error,
      },
      lastSegments: segments.slice(-20).map((s) => ({
        source: s.source,
        startMs: s.startMs,
        endMs: s.endMs,
        final: s.final,
        text: s.text,
      })),
    }
    void api.system.copy(JSON.stringify(report, null, 2))
    showToast('Diagnostics copied, paste them into an issue')
  }

  return (
    <section className={styles.panel} aria-label="Transcript">
      <header className={styles.header}>
        {query === null ? (
          <IconButton label="Search transcript" size={28} onClick={() => setQuery('')}>
            <Search size={16} strokeWidth={1.7} />
          </IconButton>
        ) : (
          <label className={styles.search}>
            <Search size={15} strokeWidth={1.7} />
            <input
              autoFocus
              value={query}
              placeholder="Search transcript"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
            />
            <button type="button" aria-label="Close search" onClick={() => setQuery(null)}>
              <X size={14} />
            </button>
          </label>
        )}
        <span className={styles.flex} />
        <IconButton label="Report a transcription problem" size={28} onClick={copyDiagnostics}>
          <ThumbsDown size={16} strokeWidth={1.7} />
        </IconButton>
        <IconButton label="Copy transcript" size={28} onClick={copyTranscript}>
          <Copy size={16} strokeWidth={1.7} />
        </IconButton>
        <IconButton label="Minimize" size={28} onClick={onCollapse}>
          <Minus size={18} strokeWidth={1.7} />
        </IconButton>
      </header>
      <div
        ref={scroller}
        className={styles.body}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <p className={styles.consent}>
          Always get consent when transcribing others.{' '}
          <button type="button" className={styles.learnMore} onClick={() => void api.system.openExternal(CONSENT_URL)}>
            Learn more <ChevronRight size={12} strokeWidth={2} />
          </button>
        </p>
        {recording?.error && <p className={styles.error}>{recording.error}</p>}
        {visible.map((s, i) => (
          <Fragment key={s.id}>
            {counterparty && s.source === 'system' && visible[i - 1]?.source !== 'system' && (
              <span className={styles.speaker}>{counterparty}</span>
            )}
            <div className={styles.bubble} data-source={s.source} data-final={s.final || undefined}>
              <Highlight text={s.text} query={q} />
              {!s.final && <span className={styles.typing} aria-hidden />}
            </div>
          </Fragment>
        ))}
        {segments.length === 0 && !recording?.error && (
          <p className={styles.waiting}>{recording ? 'Listening…' : 'No transcript for this note.'}</p>
        )}
      </div>
      <footer className={styles.footer}>{footer}</footer>
    </section>
  )
}

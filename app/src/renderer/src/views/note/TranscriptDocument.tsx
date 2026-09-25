import { useLayoutEffect, useRef, useState } from 'react'
import { Copy, Search, X } from 'lucide-react'
import type { AudioSource, TranscriptSegment } from '@shared/types'
import { speakerLabel } from '@shared/speakers'
import { api } from '@/lib/api'
import { Highlight } from '@/components/Highlight'
import { useUi } from '@/lib/ui'
import styles from './TranscriptDocument.module.css'

/** A pause this long starts a new turn even when the same person keeps talking. */
const TURN_BREAK_MS = 45_000
/** Follow new speech only when the reader is already this close to the bottom. */
const FOLLOW_THRESHOLD_PX = 120

interface Turn {
  source: AudioSource
  startMs: number
  segments: TranscriptSegment[]
}

/**
 * The whole transcript as a readable document inside the note: consecutive
 * segments from one speaker are merged into a turn, stamped with the time
 * since the meeting started.
 */
export function TranscriptDocument({
  segments,
  live,
  counterparty,
}: {
  segments: TranscriptSegment[]
  live: boolean
  counterparty: string | null
}) {
  const showToast = useUi((s) => s.showToast)
  const [query, setQuery] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const visible = q ? segments.filter((s) => s.text.toLowerCase().includes(q)) : segments
  const turns = groupTurns(visible)
  const origin = segments[0]?.startMs ?? 0
  const lastText = segments.at(-1)?.text

  useLayoutEffect(() => {
    const scroller = scrollParent(end.current)
    if (!live || q || !scroller) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (distance < FOLLOW_THRESHOLD_PX) scroller.scrollTop = scroller.scrollHeight
  }, [live, q, segments.length, lastText])

  const copy = () => {
    void api.system.copy(
      groupTurns(segments.filter((s) => s.final))
        .map((t) => `[${elapsed(t.startMs - origin)}] ${speakerLabel(t.source, counterparty)}: ${t.segments.map((s) => s.text).join(' ')}`)
        .join('\n\n'),
    )
    showToast('Transcript copied')
  }

  const duration = segments.length ? (segments.at(-1)!.endMs - origin) / 60_000 : 0
  return (
    <section className={styles.document} aria-label="Full transcript">
      <header className={styles.toolbar}>
        <span className={styles.summary}>
          {segments.length === 0 ? 'Listening…' : duration < 1 ? 'Under a minute' : `${Math.round(duration)} min`}
          {live && <span className={styles.live}>Live</span>}
        </span>
        <label className={styles.search}>
          <Search size={14} strokeWidth={1.8} />
          <input value={query} placeholder="Search transcript" onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </label>
        <button type="button" className={styles.copy} onClick={copy} disabled={segments.length === 0}>
          <Copy size={14} strokeWidth={1.8} /> Copy
        </button>
      </header>

      {q && turns.length === 0 && <p className={styles.empty}>No lines match “{query}”.</p>}
      {turns.map((turn) => (
        <div key={turn.segments[0]!.id} className={styles.turn} data-source={turn.source}>
          <div className={styles.meta}>
            <span className={styles.speaker} title={speakerLabel(turn.source, counterparty)}>
              {speakerLabel(turn.source, counterparty)}
            </span>
            <time className={styles.time} title={new Date(turn.startMs).toLocaleTimeString()}>
              {elapsed(turn.startMs - origin)}
            </time>
          </div>
          <p className={styles.text}>
            {turn.segments.map((s) => (
              <span key={s.id} data-final={s.final || undefined}>
                <Highlight text={s.text} query={q} />{' '}
              </span>
            ))}
          </p>
        </div>
      ))}
      <div ref={end} />
    </section>
  )
}

export function groupTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = []
  for (const s of segments) {
    const current = turns.at(-1)
    const lastEnd = current?.segments.at(-1)?.endMs ?? 0
    if (current && current.source === s.source && s.startMs - lastEnd < TURN_BREAK_MS) current.segments.push(s)
    else turns.push({ source: s.source, startMs: s.startMs, segments: [s] })
  }
  return turns
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

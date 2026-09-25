import { useEffect, useState } from 'react'
import { FileText, Search } from 'lucide-react'
import type { SearchHit } from '@shared/types'
import { dayHeading } from '@shared/time'
import { api } from '@/lib/api'
import { navigate } from '@/lib/router'
import { useUi } from '@/lib/ui'
import styles from './SearchPalette.module.css'

const DEBOUNCE_MS = 120

export function SearchPalette() {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearchOpen)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
    }
  }, [open])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void api.notes.search(query).then((result) => {
        if (cancelled) return
        setHits(result)
        setSelected(0)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  if (!open) return null
  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return
    setOpen(false)
    navigate({ name: 'note', id: hit.noteId })
  }

  return (
    <div className={styles.backdrop} onPointerDown={() => setOpen(false)}>
      <div className={styles.palette} onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search notes">
        <div className={styles.inputRow}>
          <Search size={16} strokeWidth={1.7} />
          <input
            autoFocus
            className={styles.input}
            placeholder="Search notes and transcripts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              else if (e.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, hits.length - 1))
              else if (e.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0))
              else if (e.key === 'Enter') choose(hits[selected])
              else return
              e.preventDefault()
            }}
          />
        </div>
        {hits.length > 0 && (
          <ul className={styles.results}>
            {hits.map((hit, i) => (
              <li key={hit.noteId}>
                <button
                  type="button"
                  className={styles.result}
                  data-selected={i === selected || undefined}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => choose(hit)}
                >
                  <FileText size={15} strokeWidth={1.7} className={styles.resultIcon} />
                  <span className={styles.resultText}>
                    <span className={styles.resultTitle}>{hit.title || 'Untitled'}</span>
                    <Snippet text={hit.snippet} />
                  </span>
                  <span className={styles.resultDate}>{dayHeading(hit.meetingAt, Date.now())}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && hits.length === 0 && <div className={styles.empty}>No matching notes</div>}
      </div>
    </div>
  )
}

/** Renders FTS snippet markers («…») as highlights without injecting HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g)
  return (
    <span className={styles.snippet}>
      {parts.map((part, i) => (part.startsWith('«') ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>))}
    </span>
  )
}

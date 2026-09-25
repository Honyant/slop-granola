// The "Meeting detected" / "Join meeting" prompt window.
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronDown, Video } from 'lucide-react'
import { joinLabel, platformOf } from '@shared/meetings'
import type { MeetingPrompt, PromptAction } from '@shared/types'
import { Spiral } from '@/components/Spiral'
import { api, useEvent } from '@/lib/api'
import '../styles/global.css'
import styles from './Prompt.module.css'

/** How long each prompt stays up; hovering pauses the countdown. */
const LIFETIME_MS: Record<MeetingPrompt['kind'], number> = { detected: 15_000, upcoming: 60_000 }

function PromptApp() {
  const [prompt, setPrompt] = useState<MeetingPrompt | null>(null)
  /** The prompt that was just withdrawn, kept on screen while it slides out. */
  const [leaving, setLeaving] = useState<MeetingPrompt | null>(null)
  const current = useRef<MeetingPrompt | null>(null)
  const show = (next: MeetingPrompt | null) => {
    if (!next && current.current) setLeaving(current.current)
    if (next) setLeaving(null)
    current.current = next
    setPrompt(next)
  }
  useEffect(() => {
    void api.prompt.current().then(show)
  }, [])
  useEvent('prompt:changed', show)
  if (prompt) return <Prompt key={prompt.id} prompt={prompt} />
  return leaving ? <Prompt key={leaving.id} prompt={leaving} leaving /> : null
}

function Prompt({ prompt, leaving = false }: { prompt: MeetingPrompt; leaving?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const lifetime = LIFETIME_MS[prompt.kind]
  const [fraction, setFraction] = useState(1)
  const remaining = useRef(lifetime)
  const root = useRef<HTMLDivElement>(null)
  const act = (action: PromptAction) => void api.prompt.act(prompt.id, action)
  const expire = useRef(() => act('expire'))
  const paused = hovered || menuOpen || leaving

  // Counts down while the pointer is away; resuming continues from where it paused.
  useEffect(() => {
    if (paused) return
    const deadline = Date.now() + remaining.current
    const timer = setInterval(() => {
      remaining.current = deadline - Date.now()
      setFraction(Math.max(0, remaining.current / lifetime))
      if (remaining.current <= 0) {
        clearInterval(timer)
        expire.current()
      }
    }, 100)
    return () => clearInterval(timer)
  }, [paused, lifetime])

  // The window is exactly as tall as the card, so the options row can grow it.
  useLayoutEffect(() => {
    if (root.current) void api.prompt.resize(root.current.getBoundingClientRect().height + 16)
  }, [menuOpen])

  const platform = platformOf(prompt.event?.url ?? null)
  const title = prompt.kind === 'detected' ? 'Meeting detected' : prompt.event.title
  const subtitle =
    prompt.kind === 'detected'
      ? prompt.event
        ? `${prompt.event.title} · ${prompt.appName}`
        : prompt.appName
      : startsIn(prompt.event.start)

  return (
    <div
      ref={root}
      className={styles.card}
      data-leaving={leaving || undefined}
      inert={leaving}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.row}>
        <div className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.subtitle}>{subtitle}</span>
        </div>
        <div className={styles.actions}>
          {prompt.kind === 'upcoming' && platform ? (
            <button type="button" className={styles.primary} onClick={() => act('join')}>
              <Video size={15} strokeWidth={1.8} className={styles[platform]} />
              {joinLabel(platform)}
            </button>
          ) : (
            <button type="button" className={styles.primary} onClick={() => act('take-notes')}>
              <span className={styles.logo}>
                <Spiral size={15} color="#212121" strokeWidth={2.8} />
              </span>
              Take notes
            </button>
          )}
          <button
            type="button"
            className={styles.more}
            aria-label="More options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <ChevronDown size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <span className={styles.countdown} style={{ width: `${fraction * 100}%` }} />
      {menuOpen && (
        <div className={styles.menu} role="menu">
          {prompt.kind === 'upcoming' && (
            <button type="button" role="menuitem" onClick={() => act('take-notes')}>
              Take notes without joining
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => act('dismiss')}>
            Dismiss
          </button>
          {prompt.kind === 'detected' && prompt.bundleId && (
            <button type="button" role="menuitem" onClick={() => act('ignore-app')}>
              Don't detect meetings in {prompt.appName}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function startsIn(startIso: string): string {
  const minutes = Math.round((Date.parse(startIso) - Date.now()) / 60_000)
  if (minutes > 0) return `Starts in ${minutes} min`
  if (minutes === 0) return 'Starting now'
  return `Started ${-minutes} min ago`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PromptApp />
  </StrictMode>,
)

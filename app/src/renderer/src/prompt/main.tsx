// The "Meeting detected" / "Join meeting" prompt window.
import { StrictMode, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronDown, Video } from 'lucide-react'
import { joinLabel, platformOf } from '@shared/meetings'
import type { MeetingPrompt, PromptAction } from '@shared/types'
import { Spiral } from '@/components/Spiral'
import { api, useEvent } from '@/lib/api'
import '../styles/global.css'
import styles from './Prompt.module.css'

/** How long a prompt stays up, as Granola's does; hovering or the open menu pauses it. */
const LIFETIME_MS = 15_000

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
  const root = useRef<HTMLDivElement>(null)
  const act = (action: PromptAction) => void api.prompt.act(prompt.id, action)
  // The countdown is a CSS animation, and its end expires the prompt, so the bar and
  // the timer cannot drift apart; pausing the animation pauses both.
  const paused = hovered || menuOpen || leaving

  // The window is exactly as tall as the card, so the options row can grow it.
  useLayoutEffect(() => {
    if (root.current) void api.prompt.resize(root.current.getBoundingClientRect().height + 2)
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
        <span
          className={styles.marker}
          data-filled={prompt.event ? true : undefined}
          style={prompt.event ? { background: prompt.event.color } : undefined}
        />
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
                <Spiral size={17} color="#212121" strokeWidth={3} turns={2} />
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
            <ChevronDown size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      <span
        className={styles.countdown}
        data-paused={paused || undefined}
        style={{ '--lifetime': `${LIFETIME_MS}ms` } as CSSProperties}
        onAnimationEnd={() => act('expire')}
      />
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

import page from './page.module.css'
import styles from './SharedView.module.css'

/**
 * Notes shared by other people. This clone is local-first with no account
 * backend, so nothing can be shared *to* you; the page is the empty state.
 */
export function SharedView() {
  return (
    <div className={page.scroll}>
      <div className={page.column}>
        <h1 className={`${page.heading} display`}>Shared with me</h1>
      </div>
      <div className={styles.empty}>
        <EmptyNotesArt />
        <div className={styles.title}>No shared notes yet</div>
        <div className={styles.subtitle}>When someone shares a note with you, it will show up here</div>
      </div>
    </div>
  )
}

function EmptyNotesArt() {
  return (
    <svg width="124" height="118" viewBox="0 0 124 118" fill="none" aria-hidden className={styles.art}>
      <rect x="4" y="16" width="70" height="92" rx="9" transform="rotate(-4 4 16)" fill="#2c2c2c" stroke="#3c3c3b" />
      <g stroke="#3c3c3b" strokeWidth="5" strokeLinecap="round">
        <path d="M17 35h16M17 49h16M17 63h16M17 77h16" />
      </g>
      <rect x="36" y="4" width="84" height="104" rx="9" transform="rotate(3 36 4)" fill="#2e2e2e" stroke="#40403f" />
      <g stroke="#434342" strokeWidth="5" strokeLinecap="round">
        <path d="M50 22l54 3M49 36l54 3M48 50l34 2M48 64l52 3" />
      </g>
      <path
        d="M101 91.5a3 3 0 1 1-3.2-3.1 5.8 5.8 0 1 1-5.5 6.2 8.7 8.7 0 1 1 9.2 9"
        stroke="#4a4a49"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

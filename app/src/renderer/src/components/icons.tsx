// Icons Granola draws differently from Lucide's closest match.

/** Sidebar toggle: rounded window with a filled left pane. */
export function SidebarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3.6" y="4.6" width="3.2" height="6.8" rx="1.1" fill="currentColor" />
    </svg>
  )
}

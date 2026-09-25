import styles from './DancingBars.module.css'

/**
 * Granola's live-audio indicator: three dots at rest that stretch into bars
 * with the input level. Driven by the level pushed from the main process,
 * not a canned animation, so it doubles as a "your mic works" signal.
 */
export function DancingBars({ level, active = true, size = 14 }: { level: number; active?: boolean; size?: number }) {
  const heights = [0.6, 1, 0.75].map((weight) => {
    const h = active ? Math.max(0.2, Math.min(1, level * weight * 1.4)) : 0.2
    return `${Math.round(h * size)}px`
  })
  return (
    <span className={styles.bars} style={{ height: size }} data-active={active} aria-hidden>
      {heights.map((height, i) => (
        <span key={i} className={styles.bar} style={{ height }} />
      ))}
    </span>
  )
}

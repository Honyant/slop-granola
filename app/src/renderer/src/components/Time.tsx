import { clock } from '@shared/time'
import styles from './Time.module.css'

/** "4:15 PM" with a small-caps meridiem, as Granola renders times. */
export function Time({ ms, meridiem = true }: { ms: number; meridiem?: boolean }) {
  const c = clock(ms)
  return (
    <span>
      {c.time}
      {meridiem && <span className={styles.meridiem}> {c.meridiem}</span>}
    </span>
  )
}

/** "4:15 – 6:45 PM", meridiem shown once when both ends share it. */
export function TimeRange({ start, end }: { start: number; end: number }) {
  const a = clock(start)
  const b = clock(end)
  return (
    <span>
      <Time ms={start} meridiem={a.meridiem !== b.meridiem} /> – <Time ms={end} />
    </span>
  )
}

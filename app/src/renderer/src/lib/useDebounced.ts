import { useEffect, useRef } from 'react'

/**
 * Coalesces object patches and applies them after `delayMs` of quiet.
 * Patches merge (a title edit and a body edit within the window both land),
 * and anything pending is flushed on unmount so navigating away never loses
 * the last keystrokes.
 */
export function useDebouncedPatch<P extends object>(apply: (patch: P) => void, delayMs: number): (patch: P) => void {
  const pending = useRef<P | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestApply = useRef(apply)
  latestApply.current = apply

  const flush = useRef(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    pending.current = null
    if (patch) latestApply.current(patch)
  }).current

  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return (patch: P) => {
    pending.current = { ...pending.current, ...patch } as P
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, delayMs)
  }
}

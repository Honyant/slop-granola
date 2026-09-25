import { useEffect, useRef } from 'react'
import { createClient, type Events } from '@shared/ipc'

export const api = createClient(window.granola)

/** Subscribes to a main-process event for the lifetime of the component. */
export function useEvent<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): void {
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => window.granola.on(event, (payload) => latest.current(payload)), [event])
}

/** Electron prefixes errors crossing IPC; users should only see the message. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

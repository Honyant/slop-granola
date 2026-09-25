import type { Bridge } from '@shared/ipc'

declare global {
  interface Window {
    granola: Bridge
  }
}

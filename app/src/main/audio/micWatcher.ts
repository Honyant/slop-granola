// Runs `granola-helper watch` and reports which apps are using a microphone.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { helperPath } from './helper'

export interface MicApp {
  pid: number
  name: string
  bundleId: string | null
}

const RESTART_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const

export class MicWatcher {
  private child: ChildProcessWithoutNullStreams | null = null
  private restarts = 0
  private stopped = false
  private restartTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly onApps: (apps: MicApp[]) => void,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    if (this.stopped || this.child || !existsSync(helperPath())) return
    const child = spawn(helperPath(), ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as { event: string; apps: { pid: number; name: string; bundle_id: string | null }[] }
        if (message.event !== 'mic_apps') return
        this.restarts = 0
        this.onApps(message.apps.map((a) => ({ pid: a.pid, name: a.name, bundleId: a.bundle_id ?? null })))
      } catch {
        this.log(`mic watcher: ignoring malformed line`)
      }
    })
    child.stdin.on('error', () => {})
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopped) return
      // Detection is a convenience: back off instead of hammering a helper that keeps failing.
      const delay = RESTART_DELAYS_MS[Math.min(this.restarts++, RESTART_DELAYS_MS.length - 1)]!
      this.log(`mic watcher exited (${signal ?? code}); restarting in ${delay / 1000}s`)
      this.restartTimer = setTimeout(() => this.start(), delay)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.child?.stdin.end()
    this.child = null
  }
}

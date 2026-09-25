// Process management for granola-helper (docs/protocol-helper.md).
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FrameDecoder, type Frame } from './frames'

export function helperPath(): string {
  // Explicit override (tests, debugging) > packaged Contents/Resources/bin > dev app/resources/bin.
  if (process.env.GRANOLA_HELPER) return process.env.GRANOLA_HELPER
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'bin', 'granola-helper') : ''
  if (packaged && existsSync(packaged)) return packaged
  return join(import.meta.dirname, '../../resources/bin/granola-helper')
}

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Runs a one-shot subcommand and returns its parsed JSON output. */
export function runHelper<T>(args: string[], timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const path = helperPath()
    if (!existsSync(path)) {
      reject(new HelperError('helper_missing', `granola-helper not found at ${path}`))
      return
    }
    execFile(path, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        reject(new HelperError('bad_output', error?.message ?? `unparseable output from helper ${args[0]}`))
        return
      }
      const failure = (parsed as { error?: { code: string; message: string } }).error
      if (failure) reject(new HelperError(failure.code, failure.message))
      else if (error) reject(new HelperError('exit', error.message))
      else resolve(parsed as T)
    })
  })
}

export interface CaptureOptions {
  mic: { enabled: boolean; deviceUid: string | null; voiceProcessing: boolean }
  system: { enabled: boolean }
}

export interface CaptureHandlers {
  onFrame(frame: Frame): void
  /** Called once when the process is gone, with a reason unless it was asked to stop. */
  onExit(unexpected: string | null): void
}

/** A running `granola-helper capture` process. One per recording. */
export class CaptureProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder = new FrameDecoder()
  private stopping = false
  private exited = false

  constructor(options: CaptureOptions, handlers: CaptureHandlers) {
    this.child = spawn(helperPath(), ['capture'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderrTail = ''
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = this.decoder.push(chunk)
      } catch (error) {
        // A corrupt stream cannot be resynchronised; restart is the only safe option.
        this.child.kill('SIGKILL')
        this.finish(handlers, `corrupt helper output: ${(error as Error).message}`)
        return
      }
      for (const frame of frames) handlers.onFrame(frame)
    })
    this.child.on('error', (error) => this.finish(handlers, `failed to start helper: ${error.message}`))
    this.child.on('exit', (code, signal) =>
      this.finish(handlers, this.stopping ? null : `helper exited (${signal ?? code}): ${stderrTail.trim().slice(-300)}`),
    )
    this.child.stdin.on('error', () => {
      // EPIPE when the helper has died; the 'exit' handler reports it.
    })
    this.send({
      cmd: 'start',
      mic: { enabled: options.mic.enabled, device_uid: options.mic.deviceUid, voice_processing: options.mic.voiceProcessing },
      system: { enabled: options.system.enabled },
    })
  }

  setMic(deviceUid: string | null): void {
    this.send({ cmd: 'set_mic', device_uid: deviceUid })
  }

  /** Asks the helper to stop; resolves when it has exited (killed after a grace period). */
  stop(graceMs = 3000): Promise<void> {
    if (this.exited) return Promise.resolve()
    this.stopping = true
    this.send({ cmd: 'stop' })
    this.child.stdin.end()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private send(command: object): void {
    if (!this.child.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private finish(handlers: CaptureHandlers, reason: string | null): void {
    if (this.exited) return
    this.exited = true
    handlers.onExit(reason)
  }
}

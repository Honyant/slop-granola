// One recording: the capture helper, a transcription stream per audio source,
// echo suppression, and persistence of finals.
//
//   helper ──frames──▶ SourcePipe(mic) ──▶ Transcriber ──▶ ┐
//          └────────▶ SourcePipe(system) ─▶ Transcriber ──▶ ├─▶ onSegment ─▶ DB + renderer
//                                                                  ┘
import { randomUUID } from 'node:crypto'
import type { AudioSource, ConnectionState, InputDevice, RecordingState, TranscriptSegment } from '@shared/types'
import type { Frame, HelperEvent } from '../audio/frames'
import type { CaptureHandlers, CaptureOptions } from '../audio/helper'
import { ECHO_WINDOW_MS, isEcho, type TimedText } from './echo'
import { SAMPLE_RATE } from './clock'
import type { Transcriber, TranscriberCallbacks, TranscriptSegmentEvent } from './transcriber'

/** Gaps up to this long are zero-filled; longer ones become clock discontinuities. */
const MAX_ZERO_FILL_SAMPLES = SAMPLE_RATE
/** Upper bound on how long a mic final waits for the system side before it is judged. */
const ECHO_HOLD_MS = 8000
const STATE_EMIT_INTERVAL_MS = 100
const MAX_HELPER_RESTARTS = 3

export interface Capture {
  setMic(deviceUid: string | null): void
  stop(): Promise<void>
}

export interface SessionConfig {
  noteId: string
  capture: CaptureOptions
}

export interface SessionDeps {
  createCapture(options: CaptureOptions, handlers: CaptureHandlers): Capture
  /** One per audio source; the provider (self-hosted, Deepgram, Google) is the caller's choice. */
  createTranscriber(callbacks: TranscriberCallbacks): Transcriber
  saveFinal(segment: TranscriptSegment, suppressed: boolean): void
  onSegment(segment: TranscriptSegment): void
  onRemoved(id: string): void
  onState(state: RecordingState): void
  log(message: string): void
}

/** Feeds one source's helper chunks into its stream on a gap-aware clock. */
class SourcePipe {
  level = 0
  connection: ConnectionState = 'connecting'
  private t0UnixMs: number | null = null
  private expected: number | null = null
  /** Latest captured audio time, used to decide when echo judgement is safe. */
  lastAudioAbsMs = 0

  constructor(readonly stream: Transcriber) {}

  /** A new helper epoch (start, resume, restart): the next chunk re-anchors the clock. */
  newEpoch(t0UnixMs: number): void {
    this.t0UnixMs = t0UnixMs
    this.expected = null
  }

  /** Forces a clock anchor at the next chunk, e.g. after a device switch. */
  breakContinuity(): void {
    this.expected = null
  }

  push(sampleIndex: number, pcm: Int16Array): void {
    if (this.t0UnixMs === null) return // audio before `started` cannot be placed in time
    const absMs = (index: number) => this.t0UnixMs! + (index * 1000) / SAMPLE_RATE
    if (this.expected === null) {
      this.stream.mark(absMs(sampleIndex))
    } else {
      const gap = sampleIndex - this.expected
      if (gap > MAX_ZERO_FILL_SAMPLES) this.stream.mark(absMs(sampleIndex))
      else if (gap > 0) this.stream.push(new Int16Array(gap))
      else if (gap < 0) {
        pcm = pcm.subarray(Math.min(-gap, pcm.length))
        sampleIndex = this.expected
      }
    }
    if (pcm.length === 0) return
    this.stream.push(pcm)
    this.expected = sampleIndex + pcm.length
    this.lastAudioAbsMs = absMs(this.expected)
    this.level = Math.max(level(pcm), this.level * 0.6)
  }
}

export class RecordingSession {
  readonly startedAt = Date.now()
  private readonly id = randomUUID().slice(0, 8)
  private readonly pipes: Record<AudioSource, SourcePipe>
  private capture: Capture | null = null
  private paused = false
  private stopped = false
  private restarts = 0
  private micDevice: InputDevice | null = null
  private error: string | null = null
  private stateTimer: NodeJS.Timeout

  /** Recent system finals and the open system interim, for echo checks. */
  private systemFinals: TimedText[] = []
  private systemInterim: TimedText | null = null
  /** Mic finals awaiting echo judgement, in arrival order. */
  private pendingMic: { segment: TranscriptSegment; arrivedAt: number }[] = []

  constructor(
    private readonly config: SessionConfig,
    private readonly deps: SessionDeps,
  ) {
    const makePipe = (source: AudioSource) =>
      new SourcePipe(
        deps.createTranscriber({
          onSegment: (segment) => this.onStreamSegment(source, segment),
          onState: (state, error) => {
            deps.log(`[${source}] connection ${state}${error ? `: ${error}` : ''}`)
            this.pipes[source].connection = state
            if (error) this.error = error
            this.emitState()
          },
          log: (message) => deps.log(`[${source}] ${message}`),
        }),
      )
    this.pipes = { mic: makePipe('mic'), system: makePipe('system') }
    this.startCapture()
    this.stateTimer = setInterval(() => {
      this.judgePendingMic(false)
      this.emitState()
      this.pipes.mic.level *= 0.6
      this.pipes.system.level *= 0.6
    }, STATE_EMIT_INTERVAL_MS)
  }

  get noteId(): string {
    return this.config.noteId
  }

  state(): RecordingState {
    return {
      noteId: this.config.noteId,
      startedAt: this.startedAt,
      paused: this.paused,
      mic: { device: this.micDevice, level: this.pipes.mic.level, connection: this.pipes.mic.connection },
      system: { level: this.pipes.system.level, connection: this.pipes.system.connection },
      error: this.error,
    }
  }

  setPaused(paused: boolean): void {
    if (this.stopped || paused === this.paused) return
    this.paused = paused
    if (paused) {
      // Releasing the devices is the point of pausing (the mic indicator goes off).
      void this.capture?.stop()
      this.capture = null
      this.pipes.mic.stream.finalizeNow()
      this.pipes.system.stream.finalizeNow()
    } else {
      this.startCapture()
    }
    this.emitState()
  }

  setMic(deviceUid: string | null): void {
    this.config.capture.mic.deviceUid = deviceUid
    this.capture?.setMic(deviceUid)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.capture?.stop()
    this.capture = null
    await Promise.all([this.pipes.mic.stream.end(), this.pipes.system.stream.end()])
    clearInterval(this.stateTimer)
    this.judgePendingMic(true)
  }

  private startCapture(): void {
    this.capture = this.deps.createCapture(this.config.capture, {
      onFrame: (frame) => this.onFrame(frame),
      onExit: (reason) => {
        if (!reason || this.stopped || this.paused) return
        this.deps.log(`capture exited: ${reason}`)
        this.capture = null
        if (this.restarts++ < MAX_HELPER_RESTARTS) {
          this.startCapture()
        } else {
          this.error = 'Audio capture keeps failing. Check microphone and system audio permissions.'
          this.emitState()
        }
      },
    })
  }

  private onFrame(frame: Frame): void {
    if (frame.kind === 'audio') {
      if (!this.paused) this.pipes[frame.source].push(frame.sampleIndex, frame.pcm)
      return
    }
    this.onHelperEvent(frame.event)
  }

  private onHelperEvent(event: HelperEvent): void {
    switch (event.event) {
      case 'started':
        this.deps.log(`capture started (mic: ${event.mic?.name ?? 'none'}, system: ${event.system})`)
        this.pipes.mic.newEpoch(event.t0_unix_ms)
        this.pipes.system.newEpoch(event.t0_unix_ms)
        if (event.mic) this.micDevice = { uid: event.mic.uid, name: event.mic.name, isDefault: false }
        break
      case 'mic_changed':
        this.micDevice = { uid: event.mic.uid, name: event.mic.name, isDefault: false }
        this.pipes.mic.breakContinuity()
        break
      case 'error':
        this.deps.log(`helper ${event.source} error ${event.code}: ${event.message}`)
        this.error = describeHelperError(event.source, event.code, event.message)
        break
      case 'stopped':
        break
    }
    this.emitState()
  }

  private onStreamSegment(source: AudioSource, s: TranscriptSegmentEvent): void {
    const segment: TranscriptSegment = {
      id: `${this.id}:${source}:${s.key}`,
      noteId: this.config.noteId,
      source,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text.trim(),
      final: s.kind === 'final',
    }
    if (source === 'system') {
      if (segment.final) {
        this.systemInterim = null
        if (segment.text) this.systemFinals.push(segment)
        const horizon = segment.endMs - 4 * ECHO_WINDOW_MS - ECHO_HOLD_MS
        this.systemFinals = this.systemFinals.filter((f) => f.endMs >= horizon)
        this.publish(segment)
        this.judgePendingMic(false)
      } else {
        this.systemInterim = segment
        this.deps.onSegment(segment)
      }
      return
    }
    if (!segment.final) {
      // Hide echo interims straight away; they would flash as "me" otherwise.
      if (!this.looksLikeEcho(segment)) this.deps.onSegment(segment)
      return
    }
    this.pendingMic.push({ segment, arrivedAt: Date.now() })
    this.judgePendingMic(false)
  }

  /**
   * Decides pending mic finals once the system side can no longer produce a
   * matching transcript for them: its finals reach past the mic segment, it has
   * gone quiet past it, or the hold time has expired.
   */
  private judgePendingMic(force: boolean): void {
    const now = Date.now()
    const systemFinalEnd = this.systemFinals.at(-1)?.endMs ?? 0
    const system = this.pipes.system
    while (this.pendingMic.length > 0) {
      const { segment, arrivedAt } = this.pendingMic[0]!
      const settled =
        force ||
        systemFinalEnd >= segment.endMs ||
        (this.systemInterim === null && system.lastAudioAbsMs >= segment.endMs + ECHO_WINDOW_MS) ||
        now - arrivedAt >= ECHO_HOLD_MS ||
        !this.config.capture.system.enabled
      if (!settled) return
      this.pendingMic.shift()
      if (segment.text && this.looksLikeEcho(segment)) {
        this.deps.saveFinal(segment, true)
        this.deps.onRemoved(segment.id)
      } else {
        this.publish(segment)
      }
    }
  }

  private looksLikeEcho(segment: TimedText): boolean {
    const candidates = this.systemInterim ? [...this.systemFinals, this.systemInterim] : this.systemFinals
    return isEcho(segment, candidates)
  }

  private publish(segment: TranscriptSegment): void {
    if (!segment.text) {
      this.deps.onRemoved(segment.id)
      return
    }
    this.deps.saveFinal(segment, false)
    this.deps.onSegment(segment)
  }

  private emitState(): void {
    if (!this.stopped) this.deps.onState(this.state())
  }
}

function describeHelperError(source: string, code: string, message: string): string {
  if (code === 'permission_denied') {
    return source === 'system'
      ? 'System audio access is off. Allow "System Audio Recording" for this app in Privacy & Security.'
      : 'Microphone access is off. Allow it in Privacy & Security.'
  }
  if (code === 'device_unavailable') return `The ${source === 'mic' ? 'microphone' : 'audio device'} disconnected.`
  return message
}

/** RMS level on a perceptual 0..1 scale (-60 dBFS → 0, 0 dBFS → 1). */
export function level(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!
  const rms = Math.sqrt(sum / pcm.length) / 32768
  const db = 20 * Math.log10(Math.max(rms, 1e-6))
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

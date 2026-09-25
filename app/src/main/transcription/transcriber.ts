// What a recording needs from a transcription provider, whatever the transport.
import type { ConnectionState } from '@shared/types'

export interface TranscriptSegmentEvent {
  kind: 'interim' | 'final'
  /** Unique within the transcriber; an interim and its final share it. */
  key: string
  startMs: number // absolute unix ms
  endMs: number
  text: string
}

export interface TranscriberCallbacks {
  onSegment(segment: TranscriptSegmentEvent): void
  onState(state: ConnectionState, error: string | null): void
  log?(message: string): void
}

export interface Transcriber {
  /**
   * Declares that the next pushed sample was captured at `absMs`. Must precede
   * the first push, and is called again after any gap in capture (pause, device
   * switch, helper restart). The open segment is finalized at the boundary so
   * no segment straddles a gap.
   */
  mark(absMs: number): void
  /** 16 kHz mono PCM. */
  push(pcm: Int16Array): void
  /** Closes the open segment now (e.g. on pause) without waiting for end-of-speech. */
  finalizeNow(): void
  /** Flushes, waits for the last finals, and closes. Idempotent. */
  end(): Promise<void>
}

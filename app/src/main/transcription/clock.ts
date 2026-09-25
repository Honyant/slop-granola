// Maps positions in a transcription stream (samples written so far) back to
// wall-clock capture time. A stream is continuous; capture is not (pauses,
// device switches, helper restarts), so each gap starts a new anchor.

export const SAMPLE_RATE = 16_000
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000

interface Anchor {
  sample: number // stream sample index
  absMs: number
}

export class StreamClock {
  private readonly anchors: Anchor[] = []

  get started(): boolean {
    return this.anchors.length > 0
  }

  /**
   * Declares that stream sample `sample` was captured at `absMs`. Returns true
   * when this opens a new anchor (a gap), false when it just moves the current
   * one (nothing was written since the last mark).
   */
  mark(sample: number, absMs: number): boolean {
    const last = this.anchors.at(-1)
    if (last && last.sample === sample) {
      last.absMs = absMs
      return false
    }
    this.anchors.push({ sample, absMs })
    return true
  }

  /**
   * Absolute time for a stream position in ms. Segment ends are exclusive, so
   * an end that lands exactly on a capture gap belongs to the audio before it.
   */
  toAbsMs(streamMs: number, edge: 'start' | 'end' = 'start'): number {
    const sample = streamMs * SAMPLES_PER_MS
    let anchor = this.anchors[0]
    if (!anchor) throw new Error('StreamClock used before the first mark')
    for (const a of this.anchors) {
      if (edge === 'start' ? a.sample > sample : a.sample >= sample) break
      anchor = a
    }
    return Math.round(anchor.absMs + (sample - anchor.sample) / SAMPLES_PER_MS)
  }
}

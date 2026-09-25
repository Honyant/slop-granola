import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '@shared/types'
import type { CaptureHandlers } from '../../src/main/audio/helper'
import { RecordingSession, level } from '../../src/main/transcription/session'
import type { Transcriber, TranscriberCallbacks, TranscriptSegmentEvent } from '../../src/main/transcription/transcriber'

class FakeStream implements Transcriber {
  marks: [number, number][] = [] // [samplesWrittenAtMark, absMs]
  samples = 0
  finalizes = 0
  constructor(readonly options: TranscriberCallbacks) {}
  mark(absMs: number) {
    this.marks.push([this.samples, absMs])
  }
  push(pcm: Int16Array) {
    this.samples += pcm.length
  }
  finalizeNow() {
    this.finalizes++
  }
  end() {
    return Promise.resolve()
  }
  emit(segment: TranscriptSegmentEvent) {
    this.options.onSegment(segment)
  }
}

function harness() {
  const streams: FakeStream[] = []
  let handlers!: CaptureHandlers
  const saved: [TranscriptSegment, boolean][] = []
  const shown = new Map<string, TranscriptSegment>()
  const session = new RecordingSession(
    {
      noteId: 'n1',
      capture: { mic: { enabled: true, deviceUid: null, voiceProcessing: true }, system: { enabled: true } },
    },
    {
      createCapture: (_o, h) => {
        handlers = h
        return { setMic: () => {}, stop: () => Promise.resolve() }
      },
      createTranscriber: (o) => {
        const s = new FakeStream(o)
        streams.push(s)
        return s
      },
      saveFinal: (s, suppressed) => saved.push([s, suppressed]),
      onSegment: (s) => shown.set(s.id, s),
      onRemoved: (id) => shown.delete(id),
      onState: () => {},
      log: () => {},
    },
  )
  const [mic, system] = streams as [FakeStream, FakeStream]
  const audio = (source: 'mic' | 'system', sampleIndex: number, ms: number) =>
    handlers.onFrame({ kind: 'audio', source, sampleIndex, pcm: new Int16Array(ms * 16) })
  handlers.onFrame({ kind: 'event', event: { event: 'started', t0_unix_ms: 1_000_000, mic: null, system: true } })
  return { session, mic, system, audio, saved, shown }
}

describe('RecordingSession', () => {
  afterEach(() => vi.useRealTimers())

  it('anchors each source on the shared helper clock, zero-fills small gaps and re-anchors large ones', async () => {
    const h = harness()
    h.audio('system', 1600, 100) // starts 100 ms after t0
    h.audio('system', 3200 + 800, 100) // 50 ms gap → zero-filled
    h.audio('system', 3200 + 800 + 1600 + 32_000, 100) // 2 s gap → new anchor
    expect(h.system.marks).toEqual([
      [0, 1_000_100],
      [1600 + 800 + 1600, 1_000_000 + (3200 + 800 + 1600 + 32_000) / 16],
    ])
    expect(h.system.samples).toBe(1600 + 800 + 1600 + 1600)
    await h.session.stop()
  })

  it('trims overlapping chunks instead of duplicating audio', async () => {
    const h = harness()
    h.audio('mic', 0, 100)
    h.audio('mic', 1500, 100) // overlaps the previous chunk by 100 samples
    expect(h.mic.samples).toBe(3100)
    await h.session.stop()
  })

  it('withdraws a mic final that echoes the far side, keeps it stored as suppressed', async () => {
    const h = harness()
    h.audio('system', 0, 5000)
    h.mic.emit({ kind: 'interim', key: '1:a', startMs: 1_001_000, endMs: 1_002_000, text: 'we work with' })
    h.system.emit({ kind: 'interim', key: '1:x', startMs: 1_001_000, endMs: 1_002_000, text: 'We work with organizations' })
    h.mic.emit({ kind: 'final', key: '1:a', startMs: 1_001_000, endMs: 1_003_000, text: 'we work with organizations like airbus' })
    // Not judged yet: the system side is still mid-utterance.
    expect(h.saved).toHaveLength(0)
    h.system.emit({ kind: 'final', key: '1:x', startMs: 1_001_000, endMs: 1_003_200, text: 'We work with organizations like Airbus.' })
    await h.session.stop()
    expect(h.saved.map(([s, suppressed]) => [s.source, suppressed])).toEqual([
      ['system', false],
      ['mic', true],
    ])
    expect([...h.shown.values()].map((s) => s.source)).toEqual(['system'])
  })

  it('publishes genuine mic speech once the system side has moved past it', async () => {
    const h = harness()
    h.system.emit({ kind: 'final', key: '1:x', startMs: 1_000_000, endMs: 1_000_900, text: 'Thanks everyone.' })
    h.mic.emit({ kind: 'final', key: '1:a', startMs: 1_001_000, endMs: 1_002_000, text: 'Infrastructure work.' })
    h.audio('system', 0, 4000) // system audio continues, silent, past mic end + window
    await h.session.stop()
    expect(h.saved.map(([s, suppressed]) => [s.text, suppressed])).toEqual([
      ['Thanks everyone.', false],
      ['Infrastructure work.', false],
    ])
  })

  it('finalizes both streams on pause', async () => {
    const h = harness()
    h.audio('mic', 0, 100)
    h.session.setPaused(true)
    expect(h.mic.finalizes).toBeGreaterThan(0)
    expect(h.system.finalizes).toBeGreaterThan(0)
    await h.session.stop()
  })
})

describe('level', () => {
  it('maps silence to 0 and full scale to 1', () => {
    expect(level(new Int16Array(160))).toBe(0)
    expect(level(new Int16Array(160).fill(32767))).toBeCloseTo(1, 2)
  })
})

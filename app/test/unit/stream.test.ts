import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { granolaProtocol } from '../../src/main/transcription/protocols/granola'
import type { TranscriptSegmentEvent as StreamSegment } from '../../src/main/transcription/transcriber'
import { WebSocketTranscriber } from '../../src/main/transcription/websocket'

/**
 * Minimal protocol-conformant server: emits a final every `segmentMs` of audio
 * (text = its start time), finalizes on request, and can drop the connection
 * after N samples to exercise replay.
 */
function fakeServer(opts: { segmentMs: number; dropAfterSamples?: number; token?: string }) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => {
      const ok = !opts.token || info.req.headers.authorization === `Bearer ${opts.token}`
      done(ok, ok ? undefined : 401)
    },
  })
  const starts: number[] = []
  let dropped = false
  wss.on('connection', (socket: WebSocket) => {
    let offsetMs = 0
    let samples = 0
    let segStart = 0
    const emit = (endSample: number) => {
      if (endSample <= segStart) return
      const s = offsetMs + segStart / 16
      socket.send(JSON.stringify({ type: 'final', segment_id: `${s}`, start_ms: s, end_ms: offsetMs + endSample / 16, text: `t${s}` }))
      segStart = endSample
    }
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        samples += (data as Buffer).length / 2
        while (samples - segStart >= opts.segmentMs * 16) emit(segStart + opts.segmentMs * 16)
        if (opts.dropAfterSamples && !dropped && offsetMs * 16 + samples >= opts.dropAfterSamples) {
          dropped = true
          socket.terminate()
        }
        return
      }
      const msg = JSON.parse(data.toString())
      if (msg.type === 'start') {
        offsetMs = msg.offset_ms
        starts.push(msg.offset_ms)
      } else if (msg.type === 'finalize') emit(samples)
      else if (msg.type === 'end') {
        emit(samples)
        socket.send(JSON.stringify({ type: 'closed' }))
        socket.close(1000)
      }
    })
  })
  const url = () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return { wss, url, starts }
}

const chunk = (ms: number) => new Int16Array(ms * 16)

describe('WebSocketTranscriber (Granola protocol)', () => {
  let server: ReturnType<typeof fakeServer> | null = null
  afterEach(() => server?.wss.close())

  it('maps server timestamps onto the absolute capture clock', async () => {
    server = fakeServer({ segmentMs: 500 })
    const finals: StreamSegment[] = []
    const stream = new WebSocketTranscriber(granolaProtocol({ url: server.url(), token: '', language: 'en' }), {
      onSegment: (s) => s.kind === 'final' && finals.push(s),
      onState: () => {},
    })
    stream.mark(1_000_000)
    for (let i = 0; i < 20; i++) stream.push(chunk(100)) // 2 s
    await stream.end()
    expect(finals.map((f) => f.startMs)).toEqual([1_000_000, 1_000_500, 1_001_000, 1_001_500])
    expect(finals.at(-1)!.endMs).toBe(1_002_000)
  })

  it('replays unfinalized audio after a drop: full coverage, no duplicates', async () => {
    server = fakeServer({ segmentMs: 500, dropAfterSamples: 16 * 1250 })
    const finals: StreamSegment[] = []
    const stream = new WebSocketTranscriber(granolaProtocol({ url: server.url(), token: '', language: 'en' }), {
      onSegment: (s) => s.kind === 'final' && finals.push(s),
      onState: () => {},
    })
    stream.mark(0)
    for (let i = 0; i < 30; i++) {
      stream.push(chunk(100))
      await new Promise((r) => setTimeout(r, 5))
    }
    await stream.end()
    // Second connection resumed exactly at the end of the last final (1000 ms).
    expect(server.starts).toEqual([0, 1000])
    const covered = finals.map((f) => [f.startMs, f.endMs])
    expect(covered).toEqual([
      [0, 500],
      [500, 1000],
      [1000, 1500],
      [1500, 2000],
      [2000, 2500],
      [2500, 3000],
    ])
  })

  it('finalizes at capture gaps and resumes the clock at the new anchor', async () => {
    server = fakeServer({ segmentMs: 10_000 })
    const finals: StreamSegment[] = []
    const stream = new WebSocketTranscriber(granolaProtocol({ url: server.url(), token: '', language: 'en' }), {
      onSegment: (s) => s.kind === 'final' && finals.push(s),
      onState: () => {},
    })
    stream.mark(5_000)
    stream.push(chunk(300))
    stream.mark(60_000) // e.g. resumed after a pause
    stream.push(chunk(200))
    await stream.end()
    expect(finals.map((f) => [f.startMs, f.endMs])).toEqual([
      [5_000, 5_300],
      [60_000, 60_200],
    ])
  })

  it('stops retrying and reports an error when the token is rejected', async () => {
    server = fakeServer({ segmentMs: 500, token: 'right' })
    const states: [string, string | null][] = []
    const stream = new WebSocketTranscriber(granolaProtocol({ url: server.url(), token: 'wrong', language: 'en' }), {
      onSegment: () => {},
      onState: (s, e) => states.push([s, e]),
    })
    await new Promise((r) => setTimeout(r, 200))
    await stream.end()
    expect(states.at(-1)).toEqual(['closed', expect.stringContaining('401')])
  })
})

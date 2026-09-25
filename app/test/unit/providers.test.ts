import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { GoogleTranscriber, googleLanguage } from '../../src/main/transcription/google'
import { deepgramConnection, deepgramProtocol } from '../../src/main/transcription/protocols/deepgram'
import type { TranscriptSegmentEvent } from '../../src/main/transcription/transcriber'
import { WebSocketTranscriber } from '../../src/main/transcription/websocket'

const results = (start: number, duration: number, transcript: string, flags: Record<string, boolean> = {}) =>
  JSON.stringify({ type: 'Results', start, duration, channel: { alternatives: [{ transcript }] }, is_final: false, ...flags })

describe('Deepgram protocol', () => {
  it('assembles is_final pieces into one segment, finalized at speech_final', () => {
    const c = deepgramConnection(0)
    expect(c.parse(results(0, 1, 'we work'))).toEqual([
      { type: 'segment', kind: 'interim', id: '0', startMs: 0, endMs: 1000, text: 'we work' },
    ])
    expect(c.parse(results(0, 1.5, 'We work with', { is_final: true }))).toMatchObject([{ kind: 'interim', id: '0', text: 'We work with' }])
    expect(c.parse(results(1.5, 0.5, 'Airbus', { is_final: false }))).toMatchObject([{ kind: 'interim', text: 'We work with Airbus' }])
    expect(c.parse(results(1.5, 1, 'Airbus.', { is_final: true, speech_final: true }))).toEqual([
      { type: 'segment', kind: 'final', id: '0', startMs: 0, endMs: 2500, text: 'We work with Airbus.' },
    ])
    // The next utterance gets the next id.
    expect(c.parse(results(3, 1, 'Next', { is_final: true, speech_final: true }))).toMatchObject([{ kind: 'final', id: '1' }])
  })

  it('closes a pending utterance on UtteranceEnd, Finalize responses and flush', () => {
    const c = deepgramConnection(0)
    c.parse(results(0, 1, 'Hello', { is_final: true }))
    expect(c.parse(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1 }))).toMatchObject([{ kind: 'final', text: 'Hello' }])
    c.parse(results(2, 1, 'Paused here', { is_final: true, from_finalize: true }))
    expect(c.flush()).toEqual([])
    c.parse(results(4, 1, 'Trailing', { is_final: true }))
    expect(c.flush()).toMatchObject([{ kind: 'final', text: 'Trailing' }])
  })

  it('offsets timestamps by where the connection starts on the stream', () => {
    const c = deepgramConnection(60_000)
    expect(c.parse(results(1, 2, 'Hi', { is_final: true, speech_final: true }))).toMatchObject([{ startMs: 61_000, endMs: 63_000 }])
  })

  it('maps "auto" to Deepgram multilingual mode and authenticates with Token', () => {
    const p = deepgramProtocol({ apiKey: 'k', model: 'nova-3', language: 'auto' })
    expect(p.url()).toContain('language=multi')
    expect(p.url()).toContain('encoding=linear16')
    expect(p.headers()).toEqual({ Authorization: 'Token k' })
  })

  it('streams end to end through the transcriber, finishing on a clean close after CloseStream', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let authorization: string | undefined
    wss.on('connection', (socket: WebSocket, request) => {
      authorization = request.headers.authorization
      let samples = 0
      let sent = false
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          samples += (data as Buffer).length / 2
          if (!sent && samples >= 16_000) {
            sent = true
            socket.send(results(0, 0.6, 'Hello there', { is_final: true }))
          }
          return
        }
        if (JSON.parse(data.toString()).type === 'CloseStream') {
          socket.send(JSON.stringify({ type: 'Metadata' }))
          socket.close(1000)
        }
      })
    })
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const finals: TranscriptSegmentEvent[] = []
    const t = new WebSocketTranscriber(
      { ...deepgramProtocol({ apiKey: 'dg-key', model: 'nova-3', language: 'en' }), url: () => url },
      { onSegment: (s) => s.kind === 'final' && finals.push(s), onState: () => {} },
    )
    t.mark(1_000_000)
    t.push(new Int16Array(16_000))
    await new Promise((r) => setTimeout(r, 100))
    await t.end()
    wss.close()
    expect(authorization).toBe('Token dg-key')
    // The pending utterance is flushed as a final when Deepgram closes after CloseStream.
    expect(finals).toMatchObject([{ text: 'Hello there', startMs: 1_000_000, endMs: 1_000_600 }])
  })
})

describe('Google Speech-to-Text transcriber', () => {
  it('turns streaming results into interims and finals on the capture clock', async () => {
    const duplex = new PassThrough({ objectMode: true })
    const written: unknown[] = []
    duplex.on('data', (chunk) => written.push(chunk))
    const segments: TranscriptSegmentEvent[] = []
    const t = new GoogleTranscriber(
      { google: { credentialsPath: '', projectId: 'p', location: 'us' }, model: 'chirp_3', language: 'en', openStream: async () => duplex },
      { onSegment: (s) => segments.push(s), onState: () => {} },
    )
    t.mark(5_000_000)
    t.push(new Int16Array(3200))
    await new Promise((r) => setImmediate(r))
    expect(written).toHaveLength(1) // audio queued while the request opened is sent once it is open

    duplex.emit('data', { results: [{ alternatives: [{ transcript: 'We work' }], isFinal: false, resultEndOffset: { seconds: 1 } }] })
    duplex.emit('data', {
      results: [
        { alternatives: [{ transcript: 'We work with Airbus.' }], isFinal: true, resultEndOffset: { seconds: 2, nanos: 500_000_000 } },
      ],
    })
    duplex.emit('data', { results: [{ alternatives: [{ transcript: 'Next' }], isFinal: false, resultEndOffset: { seconds: 3 } }] })

    expect(segments).toEqual([
      { kind: 'interim', key: '1:0', startMs: 5_000_000, endMs: 5_001_000, text: 'We work' },
      { kind: 'final', key: '1:0', startMs: 5_000_000, endMs: 5_002_500, text: 'We work with Airbus.' },
      { kind: 'interim', key: '1:1', startMs: 5_002_500, endMs: 5_003_000, text: 'Next' },
    ])
    const ended = t.end()
    duplex.end()
    await ended
  })

  it('stops for good on authentication errors', async () => {
    const states: [string, string | null][] = []
    const t = new GoogleTranscriber(
      {
        google: { credentialsPath: '', projectId: 'p', location: 'us' },
        model: 'chirp_3',
        language: 'en',
        openStream: async () => {
          throw Object.assign(new Error('Request had invalid authentication credentials'), { code: 16 })
        },
      },
      { onSegment: () => {}, onState: (s, e) => states.push([s, e]) },
    )
    await new Promise((r) => setImmediate(r))
    await t.end()
    expect(states[0]).toEqual(['closed', expect.stringContaining('invalid authentication')])
  })

  it('uses Chirp language codes', () => {
    expect(googleLanguage('en')).toBe('en-US')
    expect(googleLanguage('auto')).toBe('auto')
    expect(googleLanguage('sv-SE')).toBe('sv-SE')
  })
})

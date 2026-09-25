// A streaming transcriber over WebSocket, generic over the wire protocol
// (protocols/*.ts adapt the Granola server and Deepgram).
//
// Delivery guarantee: every sample pushed is transcribed exactly once, across
// any number of reconnects, as long as the server comes back within the replay
// window. The client retains audio from the end of the last final onward;
// after a reconnect it replays from that point, and the protocol adds that
// offset to the provider's timestamps so they stay continuous. Finals never
// overlap, so the replayed region cannot produce a duplicate.
import WebSocket from 'ws'
import type { ConnectionState } from '@shared/types'
import { SAMPLE_RATE, SAMPLES_PER_MS, StreamClock } from './clock'
import type { Transcriber, TranscriberCallbacks } from './transcriber'

/** Audio retained while the server is unreachable. Older audio is dropped (and logged). */
const MAX_REPLAY_SAMPLES = 10 * 60 * SAMPLE_RATE
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const
const END_TIMEOUT_MS = 15_000

/** Events a protocol extracts from server messages. Times are stream ms (offset already applied). */
export type ProtocolEvent =
  | { type: 'segment'; kind: 'interim' | 'final'; id: string; startMs: number; endMs: number; text: string }
  | { type: 'closed' }
  | { type: 'fatal'; message: string }
  | { type: 'log'; message: string }

export interface WsProtocol {
  /** For messages: "Transcription server", "Deepgram". */
  name: string
  url(): string
  headers(): Record<string, string>
  /** Send a keepalive after this long without traffic. */
  keepaliveMs: number
  /** Per-connection state. `offsetMs` is where on the stream this connection's audio starts. */
  connect(offsetMs: number): WsConnection
}

export interface WsConnection {
  /** Text frames to send as soon as the socket opens. */
  opening(): string[]
  finalize(): string | null
  keepalive(): string
  end(): string
  parse(text: string): ProtocolEvent[]
  /** The server closed cleanly after `end`: turn anything still pending into finals. */
  flush(): ProtocolEvent[]
}

type Item = { at: number; pcm: Int16Array } | { at: number; finalize: true }

export class WebSocketTranscriber implements Transcriber {
  private socket: WebSocket | null = null
  private session: WsConnection | null = null
  private connection = 0
  private state: ConnectionState = 'connecting'
  private attempt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private readonly keepaliveTimer: NodeJS.Timeout
  private lastSendAt = 0

  /** Total samples pushed; the stream's own continuous clock. */
  private written = 0
  /** Everything before this sample is covered by a final (or dropped). */
  private committed = 0
  /** Next sample to send on the current connection. */
  private sentUpTo = 0
  /** Retained audio and finalize markers from `committed` onward, in stream order. */
  private items: Item[] = []
  /** Index of the next item to send on the current connection. */
  private cursor = 0
  private readonly clock = new StreamClock()

  private ending: { resolve(): void; timer: NodeJS.Timeout } | null = null
  private endPromise: Promise<void> | null = null
  private fatalError: string | null = null

  constructor(
    private readonly protocol: WsProtocol,
    private readonly callbacks: TranscriberCallbacks,
  ) {
    this.connect()
    this.keepaliveTimer = setInterval(
      () => {
        if (this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastSendAt >= protocol.keepaliveMs) {
          this.sendText(this.session!.keepalive())
        }
      },
      Math.min(protocol.keepaliveMs, 5000),
    )
  }

  mark(absMs: number): void {
    if (this.clock.mark(this.written, absMs)) this.finalizeNow()
  }

  finalizeNow(): void {
    const last = this.items.at(-1)
    if (this.written === 0 || (last && 'finalize' in last && last.at === this.written)) return
    this.enqueue({ at: this.written, finalize: true })
  }

  push(pcm: Int16Array): void {
    if (!this.clock.started) throw new Error('Transcriber.push before mark()')
    if (pcm.length === 0 || this.ending) return
    this.enqueue({ at: this.written, pcm })
    this.written += pcm.length
    this.trimToWindow()
  }

  end(): Promise<void> {
    this.endPromise ??= new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log('timed out waiting for final segments')
        this.shutdown()
      }, END_TIMEOUT_MS)
      this.ending = { resolve, timer }
      if (this.fatalError) this.shutdown()
      else if (this.socket?.readyState === WebSocket.OPEN) this.sendText(this.session!.end())
      // Otherwise the reconnect path sends `end` once the buffer is replayed.
    })
    return this.endPromise
  }

  private enqueue(item: Item): void {
    this.items.push(item)
    if (this.socket?.readyState === WebSocket.OPEN) this.drain()
  }

  /** Sends every item after the cursor. Items are in stream order, so a finalize follows its audio. */
  private drain(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.session) return
    while (this.cursor < this.items.length) {
      const item = this.items[this.cursor++]!
      if ('finalize' in item) {
        const message = this.session.finalize()
        if (message) this.sendText(message)
        continue
      }
      // On replay the first item may start before the committed point.
      const slice = item.pcm.subarray(Math.max(this.sentUpTo - item.at, 0))
      socket.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength), { binary: true })
      this.sentUpTo = item.at + item.pcm.length
      this.lastSendAt = Date.now()
    }
  }

  private connect(): void {
    if (this.fatalError) return
    const connection = ++this.connection
    this.setState(connection === 1 ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.protocol.url(), { headers: this.protocol.headers(), handshakeTimeout: 10_000 })
    this.socket = socket

    socket.on('open', () => {
      this.attempt = 0
      // Replay from the last committed position; the protocol offsets the provider's clock.
      this.sentUpTo = this.committed
      this.cursor = 0
      this.session = this.protocol.connect(this.committed / SAMPLES_PER_MS)
      for (const message of this.session.opening()) socket.send(message)
      this.lastSendAt = Date.now()
      this.setState('open')
      this.drain()
      if (this.ending) this.sendText(this.session.end())
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary || connection !== this.connection || !this.session) return
      this.handle(connection, this.session.parse(data.toString()))
    })
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      if (status === 401 || status === 403) this.fail(`${this.protocol.name} rejected the credentials (HTTP ${status})`)
      else this.log(`HTTP ${status} on upgrade`)
      socket.terminate()
    })
    socket.on('error', (error) => this.log(error.message))
    socket.on('close', (code) => {
      if (connection !== this.connection) return
      this.socket = null
      // After `end`, a clean close is how some providers (Deepgram) say "done".
      if (this.ending && code === 1000 && this.session) {
        this.handle(connection, [...this.session.flush(), { type: 'closed' }])
        return
      }
      this.scheduleReconnect()
    })
  }

  private handle(connection: number, events: ProtocolEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'segment':
          if (event.kind === 'final') {
            // Everything before the end of a final is transcribed for good.
            this.committed = Math.max(this.committed, Math.min(event.endMs * SAMPLES_PER_MS, this.sentUpTo))
            this.dropCommitted()
          }
          this.callbacks.onSegment({
            kind: event.kind,
            key: `${connection}:${event.id}`,
            startMs: this.clock.toAbsMs(event.startMs),
            endMs: this.clock.toAbsMs(event.endMs, 'end'),
            text: event.text,
          })
          break
        case 'closed':
          // The server has flushed everything it had.
          this.committed = this.sentUpTo
          this.dropCommitted()
          if (this.ending) this.shutdown()
          break
        case 'fatal':
          this.fail(event.message)
          break
        case 'log':
          this.log(event.message)
          break
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.fatalError || this.retryTimer) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.setState('reconnecting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private fail(error: string): void {
    this.fatalError = error
    this.setState('closed', error)
    if (this.ending) this.shutdown()
  }

  private shutdown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    clearInterval(this.keepaliveTimer)
    this.retryTimer = null
    this.setState('closed', this.fatalError)
    const socket = this.socket
    this.socket = null
    this.connection++ // ignore anything the old socket still delivers
    socket?.close(1000)
    if (this.ending) {
      clearTimeout(this.ending.timer)
      this.ending.resolve()
    }
  }

  private dropCommitted(): void {
    let keep = 0
    while (keep < this.items.length) {
      const item = this.items[keep]!
      const end = 'pcm' in item ? item.at + item.pcm.length : item.at
      if (end > this.committed) break
      keep++
    }
    if (keep === 0) return
    this.items = this.items.slice(keep)
    this.cursor = Math.max(0, this.cursor - keep)
  }

  private trimToWindow(): void {
    const excess = this.written - this.committed - MAX_REPLAY_SAMPLES
    if (excess <= 0) return
    this.log(`server unreachable, dropping ${excess / SAMPLE_RATE}s of audio`)
    this.committed += excess
    this.sentUpTo = Math.max(this.sentUpTo, this.committed)
    this.dropCommitted()
  }

  private sendText(message: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(message)
    this.lastSendAt = Date.now()
  }

  private setState(state: ConnectionState, error: string | null = null): void {
    if (this.state === state && !error) return
    this.state = state
    this.callbacks.onState(state, error)
  }

  private log(message: string): void {
    this.callbacks.log?.(`${this.protocol.name}: ${message}`)
  }
}

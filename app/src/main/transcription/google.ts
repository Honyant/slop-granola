// Google Cloud Speech-to-Text v2 streaming (Chirp 3), with the user's GCP credentials.
//
// Google caps one streaming request at roughly five minutes of audio, so the
// transcriber rotates to a fresh request at the first final after ROTATE_AFTER,
// or unconditionally at FORCE_ROTATE. Each request's timestamps start at zero;
// its offset on the stream is remembered so segments stay on one clock.
// Google has no "finalize now" message: ending a request makes it finalize,
// so finalizeNow() is a rotation.
import { v2 } from '@google-cloud/speech'
import type { Duplex } from 'node:stream'
import type { ConnectionState } from '@shared/types'
import { googleProjectId, type GoogleConfig } from '../google/auth'
import { SAMPLE_RATE, SAMPLES_PER_MS, StreamClock } from './clock'
import type { Transcriber, TranscriberCallbacks } from './transcriber'

const ROTATE_AFTER_MS = 4 * 60_000
const FORCE_ROTATE_MS = 4 * 60_000 + 50_000
const END_TIMEOUT_MS = 15_000
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const
/** Audio held while no request is open (starting, or Google unreachable). Oldest is dropped beyond this. */
const MAX_BACKLOG_BYTES = 10 * 60 * SAMPLE_RATE * 2
/** gRPC status codes that retrying cannot fix. */
const FATAL_CODES = new Set([3 /* INVALID_ARGUMENT */, 7 /* PERMISSION_DENIED */, 16 /* UNAUTHENTICATED */])

export interface GoogleSttOptions {
  google: GoogleConfig
  model: string
  language: string
  /** Test seam: opens a streaming-recognize duplex. Defaults to the Speech v2 client. */
  openStream?(): Promise<Duplex>
}

interface Duration {
  seconds?: number | string | null
  nanos?: number | null
}

interface StreamingResponse {
  results?: { alternatives?: { transcript?: string | null }[] | null; isFinal?: boolean | null; resultEndOffset?: Duration | null }[] | null
}

export class GoogleTranscriber implements Transcriber {
  private readonly clock = new StreamClock()
  private written = 0
  private request: { stream: Duplex; number: number; offsetMs: number } | null = null
  private requests = 0
  private starting: Promise<void> | null = null
  private backlog: Buffer[] = []
  private backlogBytes = 0
  private attempt = 0
  private state: ConnectionState = 'connecting'
  private fatalError: string | null = null
  private ending = false
  private readonly open: () => Promise<Duplex>

  constructor(
    private readonly options: GoogleSttOptions,
    private readonly callbacks: TranscriberCallbacks,
  ) {
    this.open = options.openStream ?? (() => openGoogleStream(options))
    void this.startRequest()
  }

  mark(absMs: number): void {
    if (this.clock.mark(this.written, absMs)) this.finalizeNow()
  }

  push(pcm: Int16Array): void {
    if (!this.clock.started) throw new Error('Transcriber.push before mark()')
    if (pcm.length === 0 || this.ending || this.fatalError) return
    this.written += pcm.length
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    if (this.request && !this.starting) this.request.stream.write({ audio })
    else this.hold(Buffer.from(audio)) // copied: the caller may reuse its buffer
    const current = this.request
    if (current && this.written / SAMPLES_PER_MS - current.offsetMs >= FORCE_ROTATE_MS) this.rotate()
  }

  finalizeNow(): void {
    if (this.request && this.written / SAMPLES_PER_MS > this.request.offsetMs) this.rotate()
  }

  async end(): Promise<void> {
    if (this.ending) return
    this.ending = true
    await this.starting
    const request = this.request
    this.request = null
    if (request) await closeRequest(request.stream)
    this.setState('closed', this.fatalError)
  }

  private hold(audio: Buffer): void {
    this.backlog.push(audio)
    this.backlogBytes += audio.length
    let dropped = 0
    while (this.backlogBytes > MAX_BACKLOG_BYTES && this.backlog.length > 1) {
      const oldest = this.backlog.shift()!
      this.backlogBytes -= oldest.length
      dropped += oldest.length
    }
    if (dropped) this.callbacks.log?.(`Google Speech-to-Text unreachable; dropped ${dropped / (SAMPLE_RATE * 2)}s of audio`)
  }

  /** Ends the current request (letting it deliver its last results) and opens the next at the current position. */
  private rotate(): void {
    const old = this.request
    this.request = null
    if (old) void closeRequest(old.stream)
    void this.startRequest()
  }

  private async startRequest(): Promise<void> {
    if (this.fatalError || this.ending) return
    const number = ++this.requests
    const offsetMs = this.written / SAMPLES_PER_MS
    this.starting = (async () => {
      try {
        const stream = await this.open()
        this.request = { stream, number, offsetMs }
        this.attach(stream, number, offsetMs)
        for (const audio of this.backlog) stream.write({ audio })
        this.backlog = []
        this.backlogBytes = 0
        this.attempt = 0
        this.setState('open')
      } catch (error) {
        this.onRequestError(error as Error & { code?: number })
      } finally {
        this.starting = null
      }
    })()
    await this.starting
  }

  private attach(stream: Duplex, number: number, offsetMs: number): void {
    let lastFinalEndMs = 0
    let segment = 0
    const key = () => `${number}:${segment}`
    stream.on('data', (response: StreamingResponse) => {
      const results = response.results ?? []
      const finals = results.filter((r) => r.isFinal)
      for (const result of finals) {
        const endMs = durationMs(result.resultEndOffset)
        const text = result.alternatives?.[0]?.transcript?.trim() ?? ''
        this.emit('final', key(), offsetMs + lastFinalEndMs, offsetMs + endMs, text)
        lastFinalEndMs = endMs
        segment++
        const current = this.request
        if (current?.number === number && endMs >= ROTATE_AFTER_MS) this.rotate()
      }
      const interim = results
        .filter((r) => !r.isFinal)
        .map((r) => r.alternatives?.[0]?.transcript ?? '')
        .join('')
        .trim()
      if (interim) {
        const endMs = Math.max(lastFinalEndMs, ...results.map((r) => durationMs(r.resultEndOffset)))
        this.emit('interim', key(), offsetMs + lastFinalEndMs, offsetMs + endMs, interim)
      }
    })
    stream.on('error', (error: Error & { code?: number }) => {
      if (this.request?.number !== number) return // an old, rotated-out request
      this.request = null
      this.onRequestError(error)
    })
  }

  private onRequestError(error: Error & { code?: number }): void {
    if (error.code !== undefined && FATAL_CODES.has(error.code)) {
      this.fatalError = `Google Speech-to-Text: ${error.message}`
      this.setState('closed', this.fatalError)
      return
    }
    this.callbacks.log?.(`Google Speech-to-Text: ${error.message}; reconnecting`)
    this.setState('reconnecting')
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!
    setTimeout(() => void this.startRequest(), delay)
  }

  private emit(kind: 'interim' | 'final', key: string, startMs: number, endMs: number, text: string): void {
    this.callbacks.onSegment({
      kind,
      key,
      startMs: this.clock.toAbsMs(startMs),
      endMs: this.clock.toAbsMs(Math.max(startMs, endMs), 'end'),
      text,
    })
  }

  private setState(state: ConnectionState, error: string | null = null): void {
    if (this.state === state && !error) return
    this.state = state
    this.callbacks.onState(state, error)
  }
}

async function openGoogleStream(options: GoogleSttOptions): Promise<Duplex> {
  const { google } = options
  const project = await googleProjectId(google)
  const client = new v2.SpeechClient({
    apiEndpoint: google.location === 'global' ? 'speech.googleapis.com' : `${google.location}-speech.googleapis.com`,
    ...(google.credentialsPath ? { keyFilename: google.credentialsPath } : {}),
  })
  const stream = client._streamingRecognize()
  stream.write({
    recognizer: `projects/${project}/locations/${google.location}/recognizers/_`,
    streamingConfig: {
      config: {
        explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE, audioChannelCount: 1 },
        languageCodes: [googleLanguage(options.language)],
        model: options.model || 'chirp_3',
        features: { enableAutomaticPunctuation: true },
      },
      streamingFeatures: { interimResults: true },
    },
  })
  return stream
}

/** Half-closes a request and waits for its last results (bounded). */
function closeRequest(stream: Duplex): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, END_TIMEOUT_MS)
    stream.once('end', done)
    stream.once('close', done)
    stream.once('error', done)
    stream.end()
  })
}

function durationMs(d: Duration | null | undefined): number {
  if (!d) return 0
  return Number(d.seconds ?? 0) * 1000 + Math.round((d.nanos ?? 0) / 1e6)
}

/** Chirp wants BCP-47 with a region; "auto" is its language-detection mode. */
export function googleLanguage(code: string): string {
  const regions: Record<string, string> = {
    en: 'en-US',
    es: 'es-US',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-BR',
    nl: 'nl-NL',
    zh: 'cmn-Hans-CN',
    ja: 'ja-JP',
    ko: 'ko-KR',
    hi: 'hi-IN',
  }
  return code === 'auto' ? 'auto' : (regions[code] ?? code)
}

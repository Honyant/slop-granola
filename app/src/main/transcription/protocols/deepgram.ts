// Deepgram live transcription (wss://api.deepgram.com/v1/listen), bring-your-own key.
//
// Deepgram finalizes an utterance piecewise: several `is_final` results, the
// last flagged `speech_final` (end of speech) or followed by `UtteranceEnd`.
// The app's model is one segment per utterance, so is_final pieces accumulate
// into a pending segment that is shown as an interim until the utterance ends.
// Deepgram's timestamps are seconds since this connection's first audio.
import { SAMPLE_RATE } from '../clock'
import type { ProtocolEvent, WsProtocol } from '../websocket'

interface DeepgramMessage {
  type: 'Results' | 'UtteranceEnd' | 'Metadata' | 'SpeechStarted' | 'Error' | string
  start?: number
  duration?: number
  is_final?: boolean
  speech_final?: boolean
  from_finalize?: boolean
  channel?: { alternatives?: { transcript?: string }[] }
  description?: string
  message?: string
}

export const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen'

export function deepgramProtocol(options: { apiKey: string; model: string; language: string }): WsProtocol {
  const params = new URLSearchParams({
    model: options.model || 'nova-3',
    // Deepgram's code-switching mode is "multi"; the app's "auto" means the same.
    language: options.language === 'auto' ? 'multi' : options.language,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
  })
  return {
    name: 'Deepgram',
    url: () => `${DEEPGRAM_URL}?${params}`,
    headers: () => ({ Authorization: `Token ${options.apiKey}` }),
    // Deepgram closes a connection after 10 s without audio or a KeepAlive.
    keepaliveMs: 4_000,
    connect: (offsetMs) => deepgramConnection(offsetMs),
  }
}

export function deepgramConnection(offsetMs: number) {
  let nextId = 0
  let pending: { startMs: number; endMs: number; parts: string[] } | null = null

  const segment = (kind: 'interim' | 'final', startMs: number, endMs: number, text: string): ProtocolEvent => ({
    type: 'segment',
    kind,
    id: String(nextId),
    startMs,
    endMs,
    text,
  })
  const finishPending = (): ProtocolEvent[] => {
    if (!pending) return []
    const event = segment('final', pending.startMs, pending.endMs, pending.parts.join(' '))
    pending = null
    nextId++
    return [event]
  }

  return {
    opening: () => [],
    finalize: () => JSON.stringify({ type: 'Finalize' }),
    keepalive: () => JSON.stringify({ type: 'KeepAlive' }),
    end: () => JSON.stringify({ type: 'CloseStream' }),
    flush: finishPending,
    parse(text: string): ProtocolEvent[] {
      let message: DeepgramMessage
      try {
        message = JSON.parse(text) as DeepgramMessage
      } catch {
        return [{ type: 'log', message: 'ignoring non-JSON message' }]
      }
      if (message.type === 'UtteranceEnd') return finishPending()
      if (message.type === 'Error') return [{ type: 'log', message: message.description ?? message.message ?? 'error' }]
      if (message.type !== 'Results') return []

      const transcript = message.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
      const startMs = offsetMs + Math.round((message.start ?? 0) * 1000)
      const endMs = startMs + Math.round((message.duration ?? 0) * 1000)
      if (!message.is_final) {
        if (!transcript) return []
        const parts = pending ? [...pending.parts, transcript] : [transcript]
        return [segment('interim', pending?.startMs ?? startMs, endMs, parts.join(' '))]
      }
      if (transcript) {
        pending ??= { startMs, endMs, parts: [] }
        pending.parts.push(transcript)
        pending.endMs = endMs
      }
      if (message.speech_final || message.from_finalize) return finishPending()
      return pending ? [segment('interim', pending.startMs, pending.endMs, pending.parts.join(' '))] : []
    },
  }
}

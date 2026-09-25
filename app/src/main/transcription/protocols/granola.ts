// The Granola transcription protocol (docs/protocol-transcription.md): what the
// self-hosted server in server/ speaks, on a GPU box or on this Mac.
import { SAMPLE_RATE } from '../clock'
import type { ProtocolEvent, WsProtocol } from '../websocket'

interface ServerMessage {
  type: 'ready' | 'interim' | 'final' | 'error' | 'closed'
  segment_id?: string
  start_ms?: number
  end_ms?: number
  text?: string
  code?: string
  message?: string
  fatal?: boolean
}

export function granolaProtocol(options: { url: string; token: string; language: string }): WsProtocol {
  return {
    name: 'Transcription server',
    url: () => options.url,
    headers: (): Record<string, string> => (options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    keepaliveMs: 10_000,
    connect: (offsetMs) => ({
      opening: () => [
        JSON.stringify({
          type: 'start',
          sample_rate: SAMPLE_RATE,
          encoding: 'pcm_s16le',
          language: options.language,
          offset_ms: offsetMs,
          interim_results: true,
        }),
      ],
      finalize: () => JSON.stringify({ type: 'finalize' }),
      keepalive: () => JSON.stringify({ type: 'keepalive' }),
      end: () => JSON.stringify({ type: 'end' }),
      flush: () => [],
      parse: (text) => parse(text),
    }),
  }
}

/** The server applies `offset_ms` itself, so its timestamps are already stream positions. */
function parse(text: string): ProtocolEvent[] {
  let message: ServerMessage
  try {
    message = JSON.parse(text) as ServerMessage
  } catch {
    return [{ type: 'log', message: 'ignoring non-JSON message' }]
  }
  switch (message.type) {
    case 'interim':
    case 'final': {
      const startMs = message.start_ms ?? 0
      return [
        {
          type: 'segment',
          kind: message.type,
          id: message.segment_id ?? String(startMs),
          startMs,
          endMs: message.end_ms ?? startMs,
          text: message.text ?? '',
        },
      ]
    }
    case 'error':
      return message.code === 'unauthorized'
        ? [{ type: 'fatal', message: 'Transcription server rejected the token' }]
        : [{ type: 'log', message: `server error ${message.code}: ${message.message}` }]
    case 'closed':
      return [{ type: 'closed' }]
    case 'ready':
      return []
  }
}

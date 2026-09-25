// Language-model access behind one streaming interface.
//
//  - openai: any OpenAI-compatible Chat Completions API. One wire protocol
//    covers the self-hosted server's Ollama pass-through, Ollama on this Mac,
//    vLLM, OpenAI, Gemini's compatibility endpoint and OpenRouter.
//  - anthropic: Claude through the official Anthropic SDK.
//  - vertex: Gemini on Vertex AI, which also speaks Chat Completions but
//    authenticates with short-lived OAuth tokens from GCP credentials.
import Anthropic from '@anthropic-ai/sdk'
import type { Settings } from '@shared/settings'
import { googleAccessToken, googleProjectId, type GoogleConfig } from '../google/auth'

export type LlmConfig =
  | { provider: 'openai'; baseUrl: string; apiKey: string; model: string }
  | { provider: 'anthropic'; apiKey: string; model: string; /** Proxies and tests; defaults to Anthropic's API. */ baseUrl?: string }
  | { provider: 'vertex'; model: string; google: GoogleConfig }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmError extends Error {}

export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  vertex: 'google/gemini-2.5-flash',
} as const

export function llmConfig(settings: Settings): LlmConfig {
  const { provider, baseUrl, apiKey, model } = settings.llm
  switch (provider) {
    case 'anthropic':
      return { provider, apiKey, model: model || DEFAULT_MODELS.anthropic }
    case 'vertex':
      return { provider, model: model || DEFAULT_MODELS.vertex, google: settings.google }
    case 'openai':
      return { provider, baseUrl, apiKey, model }
  }
}

export function isConfigured(config: LlmConfig): boolean {
  switch (config.provider) {
    case 'openai':
      return config.baseUrl.trim() !== '' && config.model.trim() !== ''
    case 'anthropic':
      return config.apiKey.trim() !== ''
    case 'vertex':
      return true // credentials may come from gcloud's application-default login
  }
}

/** Streams text deltas. Throws LlmError on provider or protocol failure. */
export async function* streamChat(config: LlmConfig, messages: LlmMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  if (!isConfigured(config)) throw new LlmError('No language model is configured. Set one in Settings → Connectors.')
  switch (config.provider) {
    case 'openai':
      yield* streamOpenAiCompatible(config.baseUrl, config.apiKey, config.model, messages, signal)
      return
    case 'anthropic':
      yield* streamAnthropic(config, messages, signal)
      return
    case 'vertex': {
      const [token, project] = await Promise.all([googleAccessToken(config.google), googleProjectId(config.google)]).catch(
        (error: Error) => {
          throw new LlmError(`Google Cloud credentials: ${error.message}`)
        },
      )
      yield* streamOpenAiCompatible(vertexBaseUrl(project, VERTEX_LOCATION), token, config.model, messages, signal)
      return
    }
  }
}

/** Non-streaming convenience wrapper. */
export async function complete(config: LlmConfig, messages: LlmMessage[], signal?: AbortSignal): Promise<string> {
  let text = ''
  for await (const delta of streamChat(config, messages, signal)) text += delta
  return text
}

/**
 * Gemini on Vertex uses the global endpoint. The Google location setting is for Speech-to-Text,
 * whose Chirp 3 locations ("us", "eu") are multi-regions that Vertex AI does not accept.
 */
const VERTEX_LOCATION = 'global'

export function vertexBaseUrl(project: string, location: string): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`
}

// --- Anthropic ---------------------------------------------------------------

/**
 * Models that support server-side refusal fallbacks: when the model declines,
 * the API reruns the request on a fallback model within the same call instead
 * of returning an empty answer.
 */
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1'])
/** Streaming, so a generous ceiling carries no timeout risk; notes rarely come close. */
const ANTHROPIC_MAX_TOKENS = 64_000

async function* streamAnthropic(
  { apiKey, model, baseUrl }: Extract<LlmConfig, { provider: 'anthropic' }>,
  messages: LlmMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns = messages
    .filter((m): m is LlmMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: turns,
      ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    },
    { signal: signal ?? null },
  )
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text
    }
    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') throw new LlmError('Claude declined to answer this request.')
  } catch (error) {
    if (error instanceof LlmError || (error as Error).name === 'AbortError') throw error
    if (error instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic rejected the API key.')
    if (error instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic rate limit reached; try again shortly.')
    if (error instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${error.status}: ${error.message}`)
    throw new LlmError(`Could not reach Anthropic: ${(error as Error).message}`)
  }
}

// --- OpenAI-compatible -------------------------------------------------------

async function* streamOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: signal ?? null,
  }).catch((error: Error) => {
    if (error.name === 'AbortError') throw error
    throw new LlmError(`Could not reach the language model at ${baseUrl}: ${error.message}`)
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new LlmError(`Language model returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }

  const decoder = new TextDecoder()
  const parser = new SseParser()
  for await (const chunk of response.body) {
    for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
      if (data === '[DONE]') return
      const delta = parseDelta(data)
      if (delta) yield delta
    }
  }
}

function parseDelta(data: string): string | null {
  let payload: { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } }
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (payload.error) throw new LlmError(payload.error.message ?? 'Language model error')
  return payload.choices?.[0]?.delta?.content ?? null
}

/** Server-sent events: returns the `data` of each complete event. Comments and other fields are ignored. */
export class SseParser {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text.replace(/\r\n?/g, '\n')
    const events: string[] = []
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) events.push(data)
    }
    return events
  }
}

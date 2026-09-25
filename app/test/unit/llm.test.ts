import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { complete, llmConfig, LlmError, vertexBaseUrl } from '../../src/main/llm/client'
import { SettingsSchema } from '@shared/settings'

/** Minimal Anthropic Messages API: records the request, streams `text` back as SSE. */
async function fakeAnthropic(text: string, stopReason = 'end_turn') {
  const requests: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ headers: req.headers, body: JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const piece of text.match(/.{1,5}/gs) ?? []) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() }
}

describe('Anthropic provider', () => {
  it('streams text through the SDK, with the system prompt split out and refusal fallbacks enabled', async () => {
    const api = await fakeAnthropic('### Notes\n- shipped')
    const text = await complete({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5', baseUrl: api.url }, [
      { role: 'system', content: 'You write notes.' },
      { role: 'user', content: 'Summarise' },
    ])
    api.close()
    expect(text).toBe('### Notes\n- shipped')
    const { headers, body } = api.requests[0]!
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(body).toMatchObject({ model: 'claude-opus-5', system: 'You write notes.', fallbacks: 'default', stream: true })
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarise' }])
  })

  it('does not send fallbacks for models that do not support them', async () => {
    const api = await fakeAnthropic('ok')
    await complete({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', baseUrl: api.url }, [{ role: 'user', content: 'hi' }])
    api.close()
    expect(api.requests[0]!.body.fallbacks).toBeUndefined()
    expect(api.requests[0]!.headers['anthropic-beta']).toBeUndefined()
  })

  it('surfaces a refusal as an error instead of an empty answer', async () => {
    const api = await fakeAnthropic('', 'refusal')
    await expect(
      complete({ provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5', baseUrl: api.url }, [{ role: 'user', content: 'x' }]),
    ).rejects.toBeInstanceOf(LlmError)
    api.close()
  })
})

describe('llmConfig', () => {
  it('fills provider defaults', () => {
    const settings = SettingsSchema.parse({ llm: { provider: 'anthropic', apiKey: 'k' } })
    expect(llmConfig(settings)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(llmConfig(SettingsSchema.parse({ llm: { provider: 'vertex' } }))).toMatchObject({ model: 'google/gemini-2.5-flash' })
  })

  it('builds regional and global Vertex endpoints', () => {
    expect(vertexBaseUrl('proj', 'us-central1')).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/endpoints/openapi',
    )
    expect(vertexBaseUrl('proj', 'global')).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi')
  })
})

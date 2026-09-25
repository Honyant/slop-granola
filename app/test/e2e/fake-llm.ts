// OpenAI-compatible chat endpoint with canned, streamed replies. Records every
// request so tests can assert on what the app actually sent to the model.
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeLlm {
  baseUrl: string
  requests: { messages: { role: string; content: string }[] }[]
  close(): Promise<void>
}

export const ENHANCED_MARKDOWN =
  '### Key takeaways\n- Partnership with Airbus and Ferrari\n\n### Next steps\n- [ ] Me: send pricing by Friday'
export const GENERATED_TITLE = 'Airbus Partnership Review'

function reply(messages: { role: string; content: string }[]): string {
  const system = messages[0]?.content ?? ''
  if (system.includes('Name this meeting')) return GENERATED_TITLE
  if (system.includes('turn a user')) return ENHANCED_MARKDOWN
  const question = messages.at(-1)?.content ?? ''
  return `You asked: ${question.slice(0, 60)}. **Airbus** came up in your meetings.`
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const requests: FakeLlm['requests'] = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const payload = JSON.parse(await body(req)) as FakeLlm['requests'][number]
    requests.push(payload)
    const text = reply(payload.messages)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // Stream in small pieces, like a real model, to exercise incremental rendering.
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      await new Promise((r) => setTimeout(r, 5))
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

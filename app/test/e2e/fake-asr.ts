// Protocol-conformant transcription server with scripted output, so UI tests
// are deterministic. Each connection emits, per `segmentMs` of received audio,
// one interim then one final with the next scripted line for that connection.
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'

export interface FakeAsr {
  url: string
  /** Every `start` message received, in order. */
  starts: { offset_ms: number; language: string }[]
  close(): Promise<void>
}

/** `scripts[i]` is the text sequence for the i-th connection (mic and system connect in any order, so pass a picker). */
export async function startFakeAsr(pickScript: (connection: number) => string[], segmentMs = 1500): Promise<FakeAsr> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const starts: FakeAsr['starts'] = []
  let connections = 0

  wss.on('connection', (socket: WebSocket) => {
    const script = pickScript(connections++)
    let offsetMs = 0
    let samples = 0
    let segStart = 0
    let line = 0
    const send = (message: object) => socket.send(JSON.stringify(message))
    const emitUpTo = (endSample: number) => {
      const text = script[line]
      if (text === undefined || endSample <= segStart) return
      const id = `s${line}`
      const start = offsetMs + segStart / 16
      const end = offsetMs + endSample / 16
      send({ type: 'interim', segment_id: id, start_ms: start, end_ms: end, text: text.split(' ').slice(0, 2).join(' ') })
      send({ type: 'final', segment_id: id, start_ms: start, end_ms: end, text })
      segStart = endSample
      line++
    }
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        samples += (data as Buffer).length / 2
        while (samples - segStart >= segmentMs * 16 && line < script.length) emitUpTo(segStart + segmentMs * 16)
        return
      }
      const message = JSON.parse(data.toString())
      if (message.type === 'start') {
        offsetMs = message.offset_ms
        starts.push({ offset_ms: message.offset_ms, language: message.language })
        send({ type: 'ready', session_id: 'fake', models: { interim: 'fake', final: 'fake' }, sample_rate: 16000 })
      } else if (message.type === 'end') {
        send({ type: 'closed' })
        socket.close(1000)
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/listen`,
    starts,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      }),
  }
}

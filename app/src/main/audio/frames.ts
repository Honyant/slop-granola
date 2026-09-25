// Incremental decoder for granola-helper's stdout framing (docs/protocol-helper.md):
// type:u8 | length:u32 LE | payload.
import type { AudioSource } from '@shared/types'

export const FRAME_AUDIO = 0x01
export const FRAME_EVENT = 0x02
const HEADER_BYTES = 5
const AUDIO_HEADER_BYTES = 9
/** Anything larger is a corrupt stream, not audio (1 s of 16 kHz s16 is 32 KB). */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

export interface HelperMic {
  uid: string
  name: string
  voice_processing: boolean
}

export type HelperEvent =
  | { event: 'started'; t0_unix_ms: number; mic: HelperMic | null; system: boolean }
  | { event: 'mic_changed'; mic: HelperMic }
  | { event: 'error'; source: 'mic' | 'system' | 'control'; code: string; message: string; fatal: boolean }
  | { event: 'stopped' }

export type Frame = { kind: 'audio'; source: AudioSource; sampleIndex: number; pcm: Int16Array } | { kind: 'event'; event: HelperEvent }

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0)

  /** Feeds a stdout chunk and returns every frame it completes. Throws on corruption. */
  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const frames: Frame[] = []
    let offset = 0
    while (this.pending.length - offset >= HEADER_BYTES) {
      const type = this.pending.readUInt8(offset)
      const length = this.pending.readUInt32LE(offset + 1)
      if (length > MAX_PAYLOAD_BYTES) throw new Error(`helper frame too large: ${length} bytes`)
      if (this.pending.length - offset - HEADER_BYTES < length) break
      const payload = this.pending.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length)
      offset += HEADER_BYTES + length
      frames.push(decode(type, payload))
    }
    this.pending = this.pending.subarray(offset)
    return frames
  }
}

function decode(type: number, payload: Buffer): Frame {
  if (type === FRAME_EVENT) return { kind: 'event', event: JSON.parse(payload.toString('utf8')) as HelperEvent }
  if (type !== FRAME_AUDIO) throw new Error(`unknown helper frame type 0x${type.toString(16)}`)
  if (payload.length < AUDIO_HEADER_BYTES || (payload.length - AUDIO_HEADER_BYTES) % 2 !== 0) {
    throw new Error(`malformed audio frame of ${payload.length} bytes`)
  }
  const sourceByte = payload.readUInt8(0)
  if (sourceByte > 1) throw new Error(`unknown audio source ${sourceByte}`)
  // Copy: the payload aliases a buffer we are about to drop, and Int16Array needs 2-byte alignment.
  const pcmBytes = payload.subarray(AUDIO_HEADER_BYTES)
  const pcm = new Int16Array(pcmBytes.length / 2)
  Buffer.from(pcm.buffer).set(pcmBytes)
  return {
    kind: 'audio',
    source: sourceByte === 0 ? 'mic' : 'system',
    sampleIndex: Number(payload.readBigUInt64LE(1)),
    pcm,
  }
}

/** Test/debug helper: encodes a frame the way the helper does. */
export function encodeFrame(frame: Frame): Buffer {
  let payload: Buffer
  let type: number
  if (frame.kind === 'event') {
    type = FRAME_EVENT
    payload = Buffer.from(JSON.stringify(frame.event), 'utf8')
  } else {
    type = FRAME_AUDIO
    payload = Buffer.alloc(AUDIO_HEADER_BYTES + frame.pcm.byteLength)
    payload.writeUInt8(frame.source === 'mic' ? 0 : 1, 0)
    payload.writeBigUInt64LE(BigInt(frame.sampleIndex), 1)
    Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength).copy(payload, AUDIO_HEADER_BYTES)
  }
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt8(type, 0)
  header.writeUInt32LE(payload.length, 1)
  return Buffer.concat([header, payload])
}

// Voice input for the chat composer: mic-only capture streamed to the same
// transcription server as meetings, with text pushed to the renderer.
import type { AppContext } from '../context'
import { CaptureProcess } from '../audio/helper'
import { createTranscriber, transcriptionProblem } from '../transcription/providers'
import type { RecordingManager } from './recording'
import type { Transcriber } from '../transcription/transcriber'

export class Dictation {
  private active: { capture: CaptureProcess; stream: Transcriber } | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly recording: RecordingManager,
  ) {}

  get isActive(): boolean {
    return this.active !== null
  }

  start(): void {
    if (this.active) return
    if (this.recording.activeNoteId) throw new Error('Voice input is unavailable while a meeting is being transcribed.')
    const settings = this.ctx.settings.get()
    const problem = transcriptionProblem(settings)
    if (problem) throw new Error(problem)
    const { audio } = settings

    const stream = createTranscriber(settings, {
      onSegment: (s) => this.ctx.emit('dictation:text', { text: s.text, final: s.kind === 'final' }),
      onState: (state, error) => {
        if (error) this.ctx.emit('dictation:text', { text: '', final: true, error })
        if (state === 'closed') void this.stop()
      },
      log: (message) => this.ctx.log(`dictation: ${message}`),
    })
    let t0: number | null = null
    let anchored = false
    const capture = new CaptureProcess(
      { mic: { enabled: true, deviceUid: audio.micDeviceUid, voiceProcessing: false }, system: { enabled: false } },
      {
        onFrame: (frame) => {
          if (frame.kind === 'event') {
            if (frame.event.event === 'started') t0 = frame.event.t0_unix_ms
            return
          }
          if (t0 === null) return
          // Dictation is one short utterance; gaps are irrelevant, so the clock is anchored once.
          if (!anchored) {
            stream.mark(t0 + frame.sampleIndex / 16)
            anchored = true
          }
          stream.push(frame.pcm)
        },
        onExit: (reason) => {
          if (reason) this.ctx.emit('dictation:text', { text: '', final: true, error: 'Microphone capture stopped unexpectedly.' })
          void this.stop()
        },
      },
    )
    this.active = { capture, stream }
  }

  /** Stops capturing and waits for the last words to be transcribed. */
  async stop(): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = null
    await active.capture.stop()
    await active.stream.end()
    this.ctx.emit('dictation:text', { text: '', final: true, done: true })
  }
}

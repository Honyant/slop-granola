// Owns the (single) active recording and its lifecycle side effects.
import type { RecordingState } from '@shared/types'
import type { AppContext } from '../context'
import { CaptureProcess } from '../audio/helper'
import { RecordingSession } from '../transcription/session'
import { createTranscriber, transcriptionProblem } from '../transcription/providers'

export class RecordingManager {
  private session: RecordingSession | null = null
  private stopping: Promise<void> | null = null
  private lastState: RecordingState | null = null
  private readonly listeners = new Set<(state: RecordingState | null) => void>()

  constructor(
    private readonly ctx: AppContext,
    /** Called after a recording ends; used to kick off note enhancement. */
    private readonly onFinished: (noteId: string) => void,
  ) {}

  get activeNoteId(): string | null {
    return this.session?.noteId ?? null
  }

  state(): RecordingState | null {
    return this.session ? this.session.state() : null
  }

  subscribe(listener: (state: RecordingState | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(noteId: string): Promise<void> {
    if (this.session?.noteId === noteId) {
      this.session.setPaused(false)
      return
    }
    await this.stop()
    const settings = this.ctx.settings.get()
    const problem = transcriptionProblem(settings)
    if (problem) throw new Error(problem)
    const { ctx } = this
    this.session = new RecordingSession(
      {
        noteId,
        capture: {
          mic: { enabled: true, deviceUid: settings.audio.micDeviceUid, voiceProcessing: settings.audio.voiceProcessing },
          system: { enabled: settings.audio.captureSystemAudio },
        },
      },
      {
        createCapture: (options, handlers) => new CaptureProcess(options, handlers),
        createTranscriber: (callbacks) => createTranscriber(settings, callbacks),
        saveFinal: (segment, suppressed) => ctx.transcripts.insert(segment, suppressed),
        onSegment: (segment) => ctx.emit('transcript:segment', segment),
        onRemoved: (id) => ctx.emit('transcript:removed', { noteId, id }),
        onState: (state) => this.publish(state),
        log: (message) => ctx.log(`recording: ${message}`),
      },
    )
    ctx.emit('notes:changed', { ids: [noteId] })
    this.publish(this.session.state())
  }

  setPaused(paused: boolean): void {
    this.session?.setPaused(paused)
  }

  setMic(deviceUid: string | null): void {
    this.ctx.settings.update({ audio: { micDeviceUid: deviceUid } })
    this.session?.setMic(deviceUid)
  }

  /** Stops the active recording, waiting for the last finals to arrive. */
  stop(): Promise<void> {
    const session = this.session
    if (!session) return this.stopping ?? Promise.resolve()
    this.session = null
    this.stopping = (async () => {
      this.publish(null)
      await session.stop()
      this.ctx.notes.reindex(session.noteId)
      this.ctx.emit('notes:changed', { ids: [session.noteId] })
      this.onFinished(session.noteId)
    })().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  private publish(state: RecordingState | null): void {
    // The session emits at 10 Hz; skip identical frames (idle levels, no change).
    if (state && this.lastState && sameState(state, this.lastState)) return
    this.lastState = state
    this.ctx.emit('recording:state', state)
    for (const listener of this.listeners) listener(state)
  }
}

function sameState(a: RecordingState, b: RecordingState): boolean {
  return (
    a.noteId === b.noteId &&
    a.paused === b.paused &&
    a.error === b.error &&
    a.mic.device?.uid === b.mic.device?.uid &&
    a.mic.connection === b.mic.connection &&
    a.system.connection === b.system.connection &&
    Math.abs(a.mic.level - b.mic.level) < 0.02 &&
    Math.abs(a.system.level - b.system.level) < 0.02
  )
}

// Picks the transcription provider from settings, and checks its credentials.
import type { Settings } from '@shared/settings'
import { googleAccessToken, googleProjectId } from '../google/auth'
import { GoogleTranscriber } from './google'
import { deepgramProtocol } from './protocols/deepgram'
import { granolaProtocol } from './protocols/granola'
import type { Transcriber, TranscriberCallbacks } from './transcriber'
import { WebSocketTranscriber } from './websocket'

/** Why transcription cannot start with these settings, or null if it can. */
export function transcriptionProblem(settings: Settings): string | null {
  const t = settings.transcription
  switch (t.provider) {
    case 'server':
      return t.url ? null : 'Transcription is not set up. Add your transcription server in Settings → Connectors.'
    case 'deepgram':
      return t.deepgramApiKey ? null : 'Add your Deepgram API key in Settings → Connectors.'
    case 'google':
      return null // credentials may come from gcloud's application-default login
  }
}

export function createTranscriber(settings: Settings, callbacks: TranscriberCallbacks): Transcriber {
  const t = settings.transcription
  switch (t.provider) {
    case 'server':
      return new WebSocketTranscriber(granolaProtocol({ url: t.url, token: t.token, language: t.language }), callbacks)
    case 'deepgram':
      return new WebSocketTranscriber(
        deepgramProtocol({ apiKey: t.deepgramApiKey, model: t.deepgramModel, language: t.language }),
        callbacks,
      )
    case 'google':
      return new GoogleTranscriber({ google: settings.google, model: t.googleModel, language: t.language }, callbacks)
  }
}

export async function testTranscription(settings: Settings): Promise<{ ok: boolean; detail: string }> {
  const problem = transcriptionProblem(settings)
  if (problem) return { ok: false, detail: problem }
  const t = settings.transcription
  try {
    switch (t.provider) {
      case 'server': {
        const health = new URL('/healthz', t.url.replace(/^ws/, 'http'))
        const response = await fetch(health, { signal: AbortSignal.timeout(5000) })
        const body = (await response.json()) as { ok?: boolean; models?: Record<string, string> }
        if (!response.ok || !body.ok) return { ok: false, detail: `Server responded HTTP ${response.status}` }
        const models = Object.values(body.models ?? {}).join(' + ')
        return { ok: true, detail: models ? `Connected · ${models}` : 'Connected' }
      }
      case 'deepgram': {
        const response = await fetch('https://api.deepgram.com/v1/projects', {
          headers: { Authorization: `Token ${t.deepgramApiKey}` },
          signal: AbortSignal.timeout(8000),
        })
        if (response.status === 401 || response.status === 403) return { ok: false, detail: 'Deepgram rejected the API key' }
        return response.ok
          ? { ok: true, detail: `Connected · ${t.deepgramModel}` }
          : { ok: false, detail: `Deepgram responded HTTP ${response.status}` }
      }
      case 'google': {
        const [project] = await Promise.all([googleProjectId(settings.google), googleAccessToken(settings.google)])
        return { ok: true, detail: `Authenticated · project ${project} · ${t.googleModel} in ${settings.google.location}` }
      }
    }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

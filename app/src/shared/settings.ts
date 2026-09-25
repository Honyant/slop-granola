// User settings. The type is inferred from the schema so validation and typing
// can never drift apart. Only the main process imports the runtime schema; the
// renderer uses `import type`.
import { z } from 'zod'
import { applyPatch, type SettingsPatch } from './settingsPatch'

export const SettingsSchema = z.object({
  profile: z
    .object({
      name: z.string().default(''),
      email: z.string().default(''),
      avatar: z.string().nullable().default(null),
    })
    .prefault({}),
  workspace: z
    .object({
      name: z.string().default(''),
      avatar: z.string().nullable().default(null),
    })
    .prefault({}),
  appearance: z.enum(['system', 'light', 'dark']).default('dark'),
  transcription: z
    .object({
      /**
       * server: a Granola transcription server (self-hosted GPU box, or this Mac).
       * deepgram / google: bring-your-own-key cloud speech-to-text.
       */
      provider: z.enum(['server', 'deepgram', 'google']).default('server'),
      url: z.string().default(''),
      token: z.string().default(''),
      language: z.string().default('en'),
      deepgramApiKey: z.string().default(''),
      deepgramModel: z.string().default('nova-3'),
      googleModel: z.string().default('chirp_3'),
    })
    .prefault({}),
  llm: z
    .object({
      /**
       * openai: any OpenAI-compatible API (self-hosted server, Ollama, OpenAI, Gemini, OpenRouter...).
       * anthropic: Claude through the Anthropic SDK. vertex: Gemini on Vertex AI with GCP credentials.
       */
      provider: z.enum(['openai', 'anthropic', 'vertex']).default('openai'),
      baseUrl: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default(''),
    })
    .prefault({}),
  /** Google Cloud credentials, shared by Speech-to-Text and Vertex AI. Empty path = gcloud's application-default credentials. */
  google: z
    .object({
      credentialsPath: z.string().default(''),
      projectId: z.string().default(''),
      location: z.string().default('us'),
    })
    .prefault({}),
  audio: z
    .object({
      micDeviceUid: z.string().nullable().default(null),
      voiceProcessing: z.boolean().default(true),
      captureSystemAudio: z.boolean().default(true),
    })
    .prefault({}),
  calendar: z
    .object({
      showInMenuBar: z.boolean().default(true),
      showEventsWithoutParticipants: z.boolean().default(true),
      /** null = every calendar the OS reports; set once the user touches a toggle. */
      visibleCalendarIds: z.array(z.string()).nullable().default(null),
    })
    .prefault({}),
  notifications: z
    .object({
      meetingStart: z.boolean().default(true),
      /** Prompt to take notes when another app starts using the microphone. */
      meetingDetected: z.boolean().default(true),
      /** Bundle ids the user chose "Don't detect" for (e.g. a dictation app). */
      ignoredApps: z.array(z.string()).default([]),
      notesReady: z.boolean().default(true),
    })
    .prefault({}),
  notes: z
    .object({
      autoEnhance: z.boolean().default(true),
      defaultTemplateId: z.string().default('meeting'),
    })
    .prefault({}),
})

export type Settings = z.infer<typeof SettingsSchema>

export type { SettingsPatch }

export function parseSettings(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw ?? {})
  // A corrupt settings row must not brick the app: fall back to defaults.
  return parsed.success ? parsed.data : SettingsSchema.parse({})
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse(applyPatch(current, patch))
}

/** Settings fields that hold credentials; stored encrypted (see SettingsRepo). */
export const SECRET_FIELDS = [
  ['transcription', 'token'],
  ['transcription', 'deepgramApiKey'],
  ['llm', 'apiKey'],
] as const

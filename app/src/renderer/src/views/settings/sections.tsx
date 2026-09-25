import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AppWindow,
  ArrowUpRight,
  AudioLines,
  BellRing,
  Bot,
  CalendarCheck,
  FileInput,
  FileText,
  Globe,
  Mail,
  Mic,
  Speaker,
  Sparkles,
  UserX,
} from 'lucide-react'
import type { Settings } from '@shared/settings'
import { applyPatch, type SettingsPatch } from '@shared/settingsPatch'
import { defaultVisibleCalendars } from '@shared/calendar'
import type { Permissions, PermissionState } from '@shared/types'
import { Avatar } from '@/components/Avatar'
import { Button, Toggle } from '@/components/controls'
import { api, errorMessage } from '@/lib/api'
import { keys, queryClient, useCalendars, useFolders, usePermissions, useSettings, useTemplates } from '@/lib/queries'
import { useUi } from '@/lib/ui'
import styles from './Settings.module.css'

const ICON = { size: 16, strokeWidth: 1.6 }

function useUpdate(): (patch: SettingsPatch) => void {
  const showToast = useUi((s) => s.showToast)
  return (patch) => {
    // Optimistic: the settings:changed event confirms (or corrects) it.
    const current = queryClient.getQueryData<Settings>(keys.settings)
    if (current) queryClient.setQueryData(keys.settings, applyPatch(current, patch))
    api.settings.update(patch).catch((error) => showToast(errorMessage(error)))
  }
}

export function Label({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.label}>
      <span>{children}</span>
      {action}
    </div>
  )
}

export function Card({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>
}

export function Row(props: { icon?: ReactNode; title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.row}>
      {props.icon && <span className={styles.rowIcon}>{props.icon}</span>}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{props.title}</span>
        {props.description && <span className={styles.rowDescription}>{props.description}</span>}
      </span>
      {props.children}
    </div>
  )
}

function Field(props: { label: string; value: string; placeholder?: string; type?: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{props.label}</span>
      <input
        className={styles.input}
        type={props.type ?? 'text'}
        value={draft ?? props.value}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== props.value) props.onCommit(draft.trim())
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

function Select<T extends string>(props: { value: T; options: [T, string][]; onChange(value: T): void; label: string }) {
  return (
    <select className={styles.select} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </select>
  )
}

const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['auto', 'Detect automatically'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
]
export const languageName = (code: string) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code
export { LANGUAGES }

export function PreferencesSection() {
  const settings = useSettings().data
  const templates = useTemplates().data ?? []
  const update = useUpdate()
  if (!settings) return null
  return (
    <>
      <Label>Appearance</Label>
      <Card>
        <Row icon={<AppWindow {...ICON} />} title="Theme" description="Granola follows your system setting when set to System">
          <Select
            label="Theme"
            value={settings.appearance}
            options={[
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ]}
            onChange={(appearance) => update({ appearance })}
          />
        </Row>
      </Card>
      <Label>Transcription</Label>
      <Card>
        <Row icon={<Globe {...ICON} />} title="Language" description="The language spoken in your meetings">
          <Select
            label="Language"
            value={settings.transcription.language}
            options={LANGUAGES}
            onChange={(language) => update({ transcription: { language } })}
          />
        </Row>
        <Row
          icon={<AudioLines {...ICON} />}
          title="Echo cancellation"
          description="Removes the other side's voice from your microphone when you're not wearing headphones"
        >
          <Toggle
            label="Echo cancellation"
            checked={settings.audio.voiceProcessing}
            onChange={(voiceProcessing) => update({ audio: { voiceProcessing } })}
          />
        </Row>
        <Row
          icon={<Speaker {...ICON} />}
          title="Transcribe computer audio"
          description="Captures the other people on your call from your speakers or headphones"
        >
          <Toggle
            label="Transcribe computer audio"
            checked={settings.audio.captureSystemAudio}
            onChange={(captureSystemAudio) => update({ audio: { captureSystemAudio } })}
          />
        </Row>
      </Card>
      <Label>Notes</Label>
      <Card>
        <Row icon={<Sparkles {...ICON} />} title="Enhance notes automatically" description="Generate AI notes as soon as a meeting ends">
          <Toggle
            label="Enhance notes automatically"
            checked={settings.notes.autoEnhance}
            onChange={(autoEnhance) => update({ notes: { autoEnhance } })}
          />
        </Row>
        <Row icon={<FileText {...ICON} />} title="Default template" description="Structure used for enhanced notes">
          <Select
            label="Default template"
            value={settings.notes.defaultTemplateId}
            options={templates.map((t) => [t.id, t.name])}
            onChange={(defaultTemplateId) => update({ notes: { defaultTemplateId } })}
          />
        </Row>
        <ImportGranolaRow />
      </Card>
      <PermissionsCard />
    </>
  )
}

function ImportGranolaRow() {
  const showToast = useUi((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const result = await api.notes.importGranola()
      if (!result) return
      const already = result.skipped ? `, ${result.skipped} already here` : ''
      showToast(`Imported ${result.imported} meeting${result.imported === 1 ? '' : 's'}${already}`)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row
      icon={<FileInput {...ICON} />}
      title="Import from Granola"
      description="Adds meetings and transcripts from a Granola transcript export (.txt)"
    >
      <Button size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? 'Importing…' : 'Import…'}
      </Button>
    </Row>
  )
}

const PERMISSION_TEXT: Record<keyof Permissions, [string, string, ReactNode]> = {
  microphone: ['Microphone', 'Transcribes what you say', <Mic {...ICON} />],
  systemAudio: ['System audio', 'Transcribes the other people on the call', <Speaker {...ICON} />],
  calendar: ['Calendar', 'Shows upcoming meetings and who is in them', <CalendarCheck {...ICON} />],
}

function PermissionsCard() {
  const permissions = usePermissions().data
  return (
    <>
      <Label>Permissions</Label>
      <Card>
        {(Object.keys(PERMISSION_TEXT) as (keyof Permissions)[]).map((kind) => (
          <Row key={kind} icon={PERMISSION_TEXT[kind][2]} title={PERMISSION_TEXT[kind][0]} description={PERMISSION_TEXT[kind][1]}>
            <PermissionControl kind={kind} state={permissions?.[kind] ?? 'unknown'} />
          </Row>
        ))}
      </Card>
    </>
  )
}

function PermissionControl({ kind, state }: { kind: keyof Permissions; state: PermissionState }) {
  if (state === 'granted') return <span className={styles.granted}>Granted</span>
  return (
    <button
      type="button"
      className={styles.accentLink}
      onClick={async () => {
        if (state === 'not_determined') {
          queryClient.setQueryData(keys.permissions, await api.system.requestPermission(kind))
        } else {
          await api.system.openPrivacySettings(kind)
        }
      }}
    >
      {state === 'not_determined' ? 'Grant access' : 'Open Settings'}
    </button>
  )
}

export function ProfileSection() {
  const settings = useSettings().data
  const update = useUpdate()
  if (!settings) return null
  return (
    <>
      <Label>Profile</Label>
      <Card>
        <div className={styles.avatarRow}>
          <Avatar name={settings.profile.name} src={settings.profile.avatar} size={48} />
          <ImagePicker label="Change photo" onPick={(avatar) => update({ profile: { avatar } })} />
          {settings.profile.avatar && (
            <Button variant="ghost" size="sm" onClick={() => update({ profile: { avatar: null } })}>
              Remove
            </Button>
          )}
        </div>
        <Field label="Name" value={settings.profile.name} onCommit={(name) => update({ profile: { name } })} />
        <Field
          label="Email"
          type="email"
          value={settings.profile.email}
          placeholder="you@company.com"
          onCommit={(email) => update({ profile: { email } })}
        />
      </Card>
      <p className={styles.hint}>Your email identifies you in meeting attendee lists, so “Me” is matched correctly.</p>
    </>
  )
}

/** Reads an image file and downsizes it to a 128px data URL (avatars are tiny). */
function ImagePicker({ label, onPick }: { label: string; onPick(dataUrl: string): void }) {
  return (
    <label className={styles.fileButton}>
      {label}
      <input
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          const bitmap = await createImageBitmap(file)
          const size = 128
          const canvas = new OffscreenCanvas(size, size)
          const scale = Math.max(size / bitmap.width, size / bitmap.height)
          const w = bitmap.width * scale
          const h = bitmap.height * scale
          canvas.getContext('2d')!.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
          const blob = await canvas.convertToBlob({ type: 'image/png' })
          const reader = new FileReader()
          reader.onload = () => onPick(reader.result as string)
          reader.readAsDataURL(blob)
          e.target.value = ''
        }}
      />
    </label>
  )
}

export function CalendarSection() {
  const settings = useSettings().data
  const calendars = useCalendars().data ?? []
  const permission = usePermissions().data?.calendar
  const update = useUpdate()
  if (!settings) return null
  const visible = settings.calendar.visibleCalendarIds ?? defaultVisibleCalendars(calendars)
  const isVisible = (id: string) => visible.includes(id)
  const setVisible = (id: string, on: boolean) => {
    const current = visible
    update({ calendar: { visibleCalendarIds: on ? [...new Set([...current, id])] : current.filter((c) => c !== id) } })
  }

  return (
    <>
      <Label>Display</Label>
      <Card>
        <Row
          icon={<AppWindow {...ICON} />}
          title="Show upcoming meetings in menu bar"
          description="Display your next meeting and time until it starts in the macOS menu bar"
        >
          <Toggle
            label="Show upcoming meetings in menu bar"
            checked={settings.calendar.showInMenuBar}
            onChange={(showInMenuBar) => update({ calendar: { showInMenuBar } })}
          />
        </Row>
        <Row
          icon={<UserX {...ICON} />}
          title="Show events with no participants"
          description="'Coming up' section will include events without participants or a video link"
        >
          <Toggle
            label="Show events with no participants"
            checked={settings.calendar.showEventsWithoutParticipants}
            onChange={(showEventsWithoutParticipants) => update({ calendar: { showEventsWithoutParticipants } })}
          />
        </Row>
      </Card>
      <Label>Permissions</Label>
      <Card>
        <Row
          icon={<CalendarCheck {...ICON} />}
          title="Calendar access"
          description="Granola reads the calendars you've added to macOS to show upcoming meetings"
        >
          <PermissionControl kind="calendar" state={permission ?? 'unknown'} />
        </Row>
      </Card>
      <Label
        action={
          <button type="button" className={styles.accentLink} onClick={() => update({ calendar: { visibleCalendarIds: null } })}>
            Reset
          </button>
        }
      >
        Visible calendars
      </Label>
      <Card>
        {calendars.length === 0 && (
          <Row title="No calendars found" description="Add an account in the macOS Calendar app, then grant calendar access." />
        )}
        {calendars.map((c) => (
          <div key={c.id} className={styles.calendarRow}>
            <span className={styles.swatch} style={{ background: c.color }} />
            <span className={styles.rowTitle}>{c.title}</span>
            <Toggle label={c.title} checked={isVisible(c.id)} onChange={(on) => setVisible(c.id, on)} />
          </div>
        ))}
      </Card>
    </>
  )
}

export function NotificationsSection() {
  const settings = useSettings().data
  const update = useUpdate()
  if (!settings) return null
  const { ignoredApps } = settings.notifications
  return (
    <>
      <Label>Meetings</Label>
      <Card>
        <Row
          icon={<AudioLines {...ICON} />}
          title="Detect meetings"
          description="When another app starts using your microphone (Zoom, Meet in a browser, FaceTime…), offer to take notes"
        >
          <Toggle
            label="Detect meetings"
            checked={settings.notifications.meetingDetected}
            onChange={(meetingDetected) => update({ notifications: { meetingDetected } })}
          />
        </Row>
        <Row
          icon={<BellRing {...ICON} />}
          title="Meeting starting"
          description="A minute before a calendar meeting with a Zoom, Meet or Teams link, offer to join it and take notes"
        >
          <Toggle
            label="Meeting starting"
            checked={settings.notifications.meetingStart}
            onChange={(meetingStart) => update({ notifications: { meetingStart } })}
          />
        </Row>
      </Card>
      {ignoredApps.length > 0 && (
        <>
          <Label>Not detected in</Label>
          <Card>
            {ignoredApps.map((bundleId) => (
              <div key={bundleId} className={styles.calendarRow}>
                <span className={styles.rowTitle}>{bundleId}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update({ notifications: { ignoredApps: ignoredApps.filter((b) => b !== bundleId) } })}
                >
                  Detect again
                </Button>
              </div>
            ))}
          </Card>
        </>
      )}
      <Label>Notes</Label>
      <Card>
        <Row icon={<Sparkles {...ICON} />} title="Notes ready" description="Get a notification when your enhanced notes are ready">
          <Toggle
            label="Notes ready"
            checked={settings.notifications.notesReady}
            onChange={(notesReady) => update({ notifications: { notesReady } })}
          />
        </Row>
      </Card>
    </>
  )
}

const LLM_PRESETS: { label: string; baseUrl: string; model: string; needsKey: boolean }[] = [
  { label: 'Ollama on this Mac', baseUrl: 'http://localhost:11434/v1', model: 'gpt-oss:20b', needsKey: false },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true },
  { label: 'Gemini API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needsKey: true },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true },
]

export function ConnectorsSection() {
  const settings = useSettings().data
  const update = useUpdate()
  if (!settings) return null
  const { transcription: t, llm } = settings
  const usesGoogle = t.provider === 'google' || llm.provider === 'vertex'
  // A self-hosted transcription server also serves its LLM pass-through on the same host.
  const serverLlmBase = t.url ? t.url.replace(/^ws/, 'http').replace(/\/v1\/listen\/?$/, '/v1') : ''

  return (
    <>
      <Label>Transcription</Label>
      <Card>
        <div className={styles.form}>
          <Segmented
            label="Transcription provider"
            value={t.provider}
            options={[
              ['server', 'Self-hosted server'],
              ['deepgram', 'Deepgram'],
              ['google', 'Google Cloud'],
            ]}
            onChange={(provider) => update({ transcription: { provider } })}
          />
          {t.provider === 'server' && (
            <>
              <Field
                label="WebSocket URL"
                value={t.url}
                placeholder="ws://127.0.0.1:8765/v1/listen"
                onCommit={(url) => update({ transcription: { url } })}
              />
              <Field label="Token" type="password" value={t.token} onCommit={(token) => update({ transcription: { token } })} />
            </>
          )}
          {t.provider === 'deepgram' && (
            <>
              <Field
                label="Deepgram API key"
                type="password"
                value={t.deepgramApiKey}
                onCommit={(deepgramApiKey) => update({ transcription: { deepgramApiKey } })}
              />
              <Field
                label="Model"
                value={t.deepgramModel}
                placeholder="nova-3"
                onCommit={(deepgramModel) => update({ transcription: { deepgramModel } })}
              />
            </>
          )}
          {t.provider === 'google' && (
            <Field
              label="Model"
              value={t.googleModel}
              placeholder="chirp_3"
              onCommit={(googleModel) => update({ transcription: { googleModel } })}
            />
          )}
          <TestButton key={t.provider} run={() => api.settings.testTranscription()} />
        </div>
      </Card>
      <p className={styles.hint}>
        {t.provider === 'server' &&
          'The Granola transcription server (server/ in the repository) on a GPU machine, or on this Mac with server/run-local.sh. Microphone and computer audio stream to it as two channels.'}
        {t.provider === 'deepgram' &&
          'Streams to Deepgram with your own API key (console.deepgram.com). Two live connections per meeting: you and the other side.'}
        {t.provider === 'google' && 'Streams to Google Cloud Speech-to-Text v2 with your project’s credentials below.'}
      </p>

      <Label>Language model</Label>
      <Card>
        <div className={styles.form}>
          <Segmented
            label="Language model provider"
            value={llm.provider}
            options={[
              ['openai', 'OpenAI-compatible'],
              ['anthropic', 'Anthropic'],
              ['vertex', 'Vertex AI'],
            ]}
            onChange={(provider) => update({ llm: { provider, model: '' } })}
          />
          {llm.provider === 'openai' && (
            <>
              <div className={styles.presets}>
                {serverLlmBase && (
                  <button
                    type="button"
                    className={styles.preset}
                    onClick={() => update({ llm: { baseUrl: serverLlmBase, apiKey: t.token } })}
                  >
                    Self-hosted server
                  </button>
                )}
                {LLM_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={styles.preset}
                    onClick={() =>
                      update({ llm: { baseUrl: preset.baseUrl, model: preset.model, ...(preset.needsKey ? {} : { apiKey: '' }) } })
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Field
                label="Base URL"
                value={llm.baseUrl}
                placeholder="https://api.openai.com/v1"
                onCommit={(baseUrl) => update({ llm: { baseUrl } })}
              />
              <Field label="Model" value={llm.model} placeholder="gpt-5-mini" onCommit={(model) => update({ llm: { model } })} />
              <Field label="API key" type="password" value={llm.apiKey} onCommit={(apiKey) => update({ llm: { apiKey } })} />
            </>
          )}
          {llm.provider === 'anthropic' && (
            <>
              <Field label="Anthropic API key" type="password" value={llm.apiKey} onCommit={(apiKey) => update({ llm: { apiKey } })} />
              <Field label="Model" value={llm.model} placeholder="claude-opus-5" onCommit={(model) => update({ llm: { model } })} />
            </>
          )}
          {llm.provider === 'vertex' && (
            <Field label="Model" value={llm.model} placeholder="google/gemini-2.5-flash" onCommit={(model) => update({ llm: { model } })} />
          )}
          <TestButton key={llm.provider} run={() => api.settings.testLlm()} />
        </div>
      </Card>
      <p className={styles.hint}>
        Used for enhanced notes, titles, chat and recipes.
        {llm.provider === 'openai' &&
          ' Works with the self-hosted server, Ollama, OpenAI, Gemini, OpenRouter, vLLM and anything else that speaks the OpenAI Chat Completions API.'}
        {llm.provider === 'anthropic' && ' Claude through the Anthropic API with your own key.'}
        {llm.provider === 'vertex' && ' Gemini on Vertex AI, billed to your Google Cloud project.'}
      </p>

      {usesGoogle && (
        <>
          <Label>Google Cloud credentials</Label>
          <Card>
            <div className={styles.form}>
              <div className={styles.fileRow}>
                <Field
                  label="Service account key (JSON)"
                  value={settings.google.credentialsPath}
                  placeholder="Empty: use gcloud application-default credentials"
                  onCommit={(credentialsPath) => update({ google: { credentialsPath } })}
                />
                <Button
                  variant="soft"
                  size="sm"
                  onClick={async () => {
                    const path = await api.system.chooseFile('Service account key', ['json'])
                    if (path) update({ google: { credentialsPath: path } })
                  }}
                >
                  Choose…
                </Button>
              </div>
              <Field
                label="Project ID"
                value={settings.google.projectId}
                placeholder="Empty: from the credentials"
                onCommit={(projectId) => update({ google: { projectId } })}
              />
              <Field
                label="Location"
                value={settings.google.location}
                placeholder="us"
                onCommit={(location) => update({ google: { location } })}
              />
            </div>
          </Card>
          <p className={styles.hint}>
            A service-account key with the Speech-to-Text and/or Vertex AI User role, or run{' '}
            <code>gcloud auth application-default login</code> and leave the path empty. Chirp 3 streams in the us and eu locations.
          </p>
        </>
      )}
    </>
  )
}

function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange(value: T): void }) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={props.label}>
      {props.options.map(([value, text]) => (
        <button key={value} type="button" role="radio" aria-checked={props.value === value} onClick={() => props.onChange(value)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function TestButton({ run }: { run(): Promise<{ ok: boolean; detail: string }> }) {
  const [state, setState] = useState<{ busy: boolean; result?: { ok: boolean; detail: string } }>({ busy: false })
  return (
    <div className={styles.test}>
      <Button
        variant="soft"
        size="sm"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true })
          try {
            setState({ busy: false, result: await run() })
          } catch (error) {
            setState({ busy: false, result: { ok: false, detail: errorMessage(error) } })
          }
        }}
      >
        {state.busy ? 'Testing…' : 'Test connection'}
      </Button>
      {state.result && <span className={state.result.ok ? styles.granted : styles.error}>{state.result.detail}</span>}
    </div>
  )
}

export function HelpSection() {
  const version = useQuery({ queryKey: ['version'], queryFn: () => api.system.version() }).data
  const link = (title: string, url: string, icon: ReactNode) => (
    <button type="button" className={styles.linkRow} onClick={() => void api.system.openExternal(url)}>
      <span className={styles.rowIcon}>{icon}</span>
      <span className={styles.rowTitle}>{title}</span>
      <ArrowUpRight size={15} strokeWidth={1.7} />
    </button>
  )
  return (
    <>
      <Label>Resources</Label>
      <Card>
        {link('Help center', 'https://docs.granola.ai', <FileText {...ICON} />)}
        {link('Contact support', 'mailto:support@granola.ai', <Mail {...ICON} />)}
      </Card>
      <p className={styles.hint}>Version {version}</p>
    </>
  )
}

export function GeneralSection() {
  const settings = useSettings().data
  const update = useUpdate()
  if (!settings) return null
  return (
    <>
      <Label>Workspace</Label>
      <Card>
        <div className={styles.avatarRow}>
          <Avatar name={settings.workspace.name} src={settings.workspace.avatar} size={48} shape="square" />
          <ImagePicker label="Change icon" onPick={(avatar) => update({ workspace: { avatar } })} />
        </div>
        <Field label="Workspace name" value={settings.workspace.name} onCommit={(name) => update({ workspace: { name } })} />
      </Card>
    </>
  )
}

export function MembersSection() {
  const profile = useSettings().data?.profile
  if (!profile) return null
  return (
    <>
      <Label>Members · 1</Label>
      <Card>
        <div className={styles.memberRow}>
          <Avatar name={profile.name} src={profile.avatar} size={32} />
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>{profile.name} (me)</span>
            <span className={styles.rowDescription}>{profile.email}</span>
          </span>
          <span className={styles.badge}>Owner</span>
        </div>
      </Card>
      <p className={styles.hint}>This workspace lives on this Mac. Share a note with anyone by copying its link from the note menu.</p>
    </>
  )
}

export function SpacesSection() {
  const folders = useFolders().data ?? []
  const [name, setName] = useState('')
  return (
    <>
      <Label>Folders</Label>
      <Card>
        {folders.map((f) => (
          <div key={f.id} className={styles.calendarRow}>
            <input
              className={styles.inlineInput}
              defaultValue={f.name}
              aria-label="Folder name"
              onBlur={(e) => e.target.value.trim() && e.target.value !== f.name && void api.folders.rename(f.id, e.target.value)}
            />
            <span className={styles.rowDescription}>
              {f.noteCount} {f.noteCount === 1 ? 'note' : 'notes'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void api.folders.remove(f.id)}>
              Delete
            </Button>
          </div>
        ))}
        <form
          className={styles.calendarRow}
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            void api.folders.create(name)
            setName('')
          }}
        >
          <input className={styles.inlineInput} placeholder="New folder name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="soft" size="sm" type="submit">
            Create
          </Button>
        </form>
      </Card>
    </>
  )
}

export function AnalyticsSection() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.notes.stats(), staleTime: 0 }).data
  if (!stats) return null
  const peak = Math.max(1, ...stats.weekly.map((w) => w.notes))
  const tiles: [string, string][] = [
    ['Notes', stats.notes.toLocaleString()],
    ['This week', stats.notesThisWeek.toLocaleString()],
    ['Hours transcribed', (stats.transcribedMinutes / 60).toFixed(1)],
    ['Words transcribed', stats.words.toLocaleString()],
  ]
  return (
    <>
      <Label>Usage</Label>
      <div className={styles.tiles}>
        {tiles.map(([label, value]) => (
          <div key={label} className={styles.tile}>
            <span className={styles.tileValue}>{value}</span>
            <span className={styles.tileLabel}>{label}</span>
          </div>
        ))}
      </div>
      <Label>Notes per week</Label>
      <Card>
        <div className={styles.chart} role="img" aria-label="Notes per week over the last 12 weeks">
          {stats.weekly.map((w) => (
            <div
              key={w.weekStart}
              className={styles.barColumn}
              title={`${new Date(w.weekStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${w.notes}`}
            >
              <div className={styles.bar} style={{ height: `${(w.notes / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

export function BillingSection() {
  return (
    <>
      <Label>Plan</Label>
      <Card>
        <Row
          icon={<Bot {...ICON} />}
          title="Basic Plan"
          description="Self-hosted: transcription and AI run on your own servers, so there is nothing to bill."
        >
          <span className={styles.badge}>Current</span>
        </Row>
      </Card>
    </>
  )
}

export function ReferralsSection() {
  return (
    <>
      <Label>Referrals</Label>
      <Card>
        <Row
          icon={<Sparkles {...ICON} />}
          title="Invite a friend"
          description="Point them at your transcription server and share the setup guide in the repository README."
        />
      </Card>
    </>
  )
}

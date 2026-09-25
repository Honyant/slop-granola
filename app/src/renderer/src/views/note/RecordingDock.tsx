import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Languages, Mic, Play, SlidersVertical, Sparkles, Square } from 'lucide-react'
import type { Note, RecordingState, TranscriptSegment } from '@shared/types'
import { AskBar } from '@/components/AskBar'
import { Toggle } from '@/components/controls'
import { DancingBars } from '@/components/DancingBars'
import { MenuItem, Popover } from '@/components/Popover'
import { api, errorMessage } from '@/lib/api'
import { useDevices, useSettings } from '@/lib/queries'
import { useUi } from '@/lib/ui'
import { LANGUAGES, languageName } from '../settings/sections'
import { TranscriptPanel } from './TranscriptPanel'
import { counterparty } from '@shared/speakers'
import styles from './RecordingDock.module.css'

interface RecordingDockProps {
  note: Note
  segments: TranscriptSegment[]
  /** Recording state if *this* note is recording. */
  recording: RecordingState | null
  enhancing: boolean
  onEnhance(): void
}

const CONSENT_URL = 'https://docs.granola.ai/help-center/consent'

export function RecordingDock({ note, segments, recording, enhancing, onEnhance }: RecordingDockProps) {
  const [expanded, setExpanded] = useState(false)
  const showToast = useUi((s) => s.showToast)
  const hasTranscript = segments.length > 0

  const start = async () => {
    try {
      await api.recording.start(note.id)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  const controls = (
    <RecordingControls
      recording={recording}
      hasTranscript={hasTranscript}
      expanded={expanded}
      onToggle={() => setExpanded((e) => !e)}
      onStart={() => void start()}
    />
  )

  const consent = recording && (
    <button type="button" className={styles.consent} onClick={() => void api.system.openExternal(CONSENT_URL)}>
      Always get consent when transcribing others <ChevronRight size={13} strokeWidth={2} />
    </button>
  )

  if (expanded) {
    return (
      <div className={styles.expanded}>
        {consent}
        <TranscriptPanel
          segments={segments}
          recording={recording}
          counterparty={counterparty(note.attendees)}
          onCollapse={() => setExpanded(false)}
          footer={
            <>
              {controls}
              <span className={styles.flex} />
              <MicPicker recording={recording} />
              <AudioOptions />
              <LanguagePicker />
            </>
          }
        />
        <p className={styles.disclaimer}>Granola uses AI and can make mistakes.</p>
      </div>
    )
  }

  const showEnhance = !recording && hasTranscript && !note.enhanced && !enhancing
  return (
    <>
      {consent && <div className={styles.consentRow}>{consent}</div>}
      <AskBar
        noteId={note.id}
        recipeSlug={null}
        className={styles.askDock}
        leading={
          <div className={styles.leading}>
            <div className={styles.controlPill}>{controls}</div>
            {showEnhance && (
              <button type="button" className={styles.enhance} onClick={onEnhance}>
                <Sparkles size={15} strokeWidth={1.8} />
                Generate notes
              </button>
            )}
          </div>
        }
      />
    </>
  )
}

interface RecordingControlsProps {
  recording: RecordingState | null
  hasTranscript: boolean
  expanded: boolean
  onToggle(): void
  onStart(): void
}

function RecordingControls({ recording, hasTranscript, expanded, onToggle, onStart }: RecordingControlsProps) {
  if (!recording) {
    return (
      <div className={styles.controls}>
        {hasTranscript && (
          <button type="button" className={styles.toggle} aria-label={expanded ? 'Hide transcript' : 'Show transcript'} onClick={onToggle}>
            <DancingBars level={0} active={false} size={13} />
            {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronUp size={14} strokeWidth={2} />}
          </button>
        )}
        <button type="button" className={styles.resume} onClick={onStart}>
          <Mic size={14} strokeWidth={1.9} />
          {hasTranscript ? 'Resume' : 'Transcribe'}
        </button>
      </div>
    )
  }
  const level = Math.max(recording.mic.level, recording.system.level)
  return (
    <div className={styles.controls}>
      <button type="button" className={styles.toggle} aria-label={expanded ? 'Hide transcript' : 'Show transcript'} onClick={onToggle}>
        <DancingBars level={recording.paused ? 0 : level} active={!recording.paused} size={13} />
        {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronUp size={14} strokeWidth={2} />}
      </button>
      {recording.paused ? (
        <button type="button" className={styles.stop} aria-label="Resume transcription" onClick={() => void api.recording.setPaused(false)}>
          <Play size={14} strokeWidth={0} fill="currentColor" />
        </button>
      ) : (
        <button type="button" className={styles.stop} aria-label="Stop transcription" onClick={() => void api.recording.stop()}>
          <Square size={13} strokeWidth={0} fill="currentColor" />
        </button>
      )}
    </div>
  )
}

function MicPicker({ recording }: { recording: RecordingState | null }) {
  const devices = useDevices().data ?? []
  const settings = useSettings().data
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const selectedUid = settings?.audio.micDeviceUid ?? null
  const current =
    recording?.mic.device?.name ??
    devices.find((d) => d.uid === selectedUid)?.name ??
    devices.find((d) => d.isDefault)?.name ??
    'Default microphone'
  return (
    <>
      <button ref={anchor} type="button" className={styles.footerButton} onClick={() => setOpen((o) => !o)}>
        {current} <ChevronDown size={15} strokeWidth={1.8} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-end">
        <MenuItem
          trailing={selectedUid === null && '✓'}
          onSelect={() => {
            setOpen(false)
            void api.recording.setMicDevice(null)
          }}
        >
          System default
        </MenuItem>
        {devices.map((d) => (
          <MenuItem
            key={d.uid}
            trailing={selectedUid === d.uid && '✓'}
            onSelect={() => {
              setOpen(false)
              void api.recording.setMicDevice(d.uid)
            }}
          >
            {d.name}
          </MenuItem>
        ))}
      </Popover>
    </>
  )
}

function AudioOptions() {
  const settings = useSettings().data
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!settings) return null
  return (
    <>
      <button ref={anchor} type="button" className={styles.footerIcon} aria-label="Audio settings" onClick={() => setOpen((o) => !o)}>
        <SlidersVertical size={16} strokeWidth={1.7} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-end" className={styles.audioMenu}>
        <label className={styles.audioRow}>
          <span>
            Echo cancellation
            <small>For speakers without headphones. Applies to the next recording.</small>
          </span>
          <Toggle
            label="Echo cancellation"
            checked={settings.audio.voiceProcessing}
            onChange={(voiceProcessing) => void api.settings.update({ audio: { voiceProcessing } })}
          />
        </label>
        <label className={styles.audioRow}>
          <span>
            Transcribe computer audio
            <small>The other people on your call.</small>
          </span>
          <Toggle
            label="Transcribe computer audio"
            checked={settings.audio.captureSystemAudio}
            onChange={(captureSystemAudio) => void api.settings.update({ audio: { captureSystemAudio } })}
          />
        </label>
      </Popover>
    </>
  )
}

function LanguagePicker() {
  const language = useSettings().data?.transcription.language ?? 'en'
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={anchor} type="button" className={styles.footerButton} onClick={() => setOpen((o) => !o)}>
        <Languages size={16} strokeWidth={1.7} />
        {languageName(language)}
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-end">
        {LANGUAGES.map(([code, name]) => (
          <MenuItem
            key={code}
            trailing={code === language && '✓'}
            onSelect={() => {
              setOpen(false)
              void api.settings.update({ transcription: { language: code } })
            }}
          >
            {name}
          </MenuItem>
        ))}
      </Popover>
    </>
  )
}

# Native helper protocol (`granola-helper`)

`granola-helper` is a Swift command-line binary shipped inside the app bundle
(`Contents/Resources/bin/granola-helper`). Electron's main process spawns it. It
owns everything that needs macOS frameworks: microphone capture, system-audio
capture, and EventKit.

Why a child process rather than a Node native addon:

- **No ABI coupling.** A `.node` addon must be rebuilt for every Electron version;
  a CLI binary never does.
- **Crash isolation.** A Core Audio fault kills the helper, not the app. The main
  process restarts it and the meeting keeps its transcript so far.
- **TCC attribution still works.** macOS attributes the helper's mic / audio-capture /
  calendar requests to the responsible parent app bundle, so the prompts say the
  app's name.
- **Testable standalone.** `granola-helper capture` can run from a terminal and be
  inspected with `xxd`.

## Subcommands

All one-shot subcommands print a single JSON document to stdout and exit 0, or
print `{"error": {"code": "...", "message": "..."}}` and exit 1. `code` is one of
`invalid_arguments`, `permission_denied` (calendar commands without full calendar
access), `internal`.

| Command | Output |
|---|---|
| `granola-helper devices` | `{"inputs": [{"uid", "name", "is_default"}]}` |
| `granola-helper permissions` | `{"microphone": S, "calendar": S, "system_audio": S}` where S ∈ `granted, denied, not_determined, restricted, unknown`; `system_audio` is always `unknown` (see below) |
| `granola-helper permissions --request microphone\|calendar\|system_audio` | same shape, after prompting |
| `granola-helper calendar list` | `{"calendars": [{"id", "title", "color", "source", "allows_modify", "is_default"}]}` — `color` is `#rrggbb`; `is_default` is true for at most one calendar, EventKit's default calendar for new events (the user's primary calendar) |
| `granola-helper calendar events --from <ISO8601> --to <ISO8601> [--calendars id,id]` | `{"events": [{"id", "calendar_id", "title", "start", "end", "all_day", "location", "url", "notes", "organizer": P?, "attendees": [P]}]}`; `P = {"name", "email", "status", "is_self"}`; times ISO-8601 with offset; `id` is unique per occurrence (recurring events share one EventKit identifier, so the occurrence start is appended); absent optional values are `null` |
| `granola-helper capture` | long-running, see below |
| `granola-helper watch` | long-running, see [`watch`](#watch) |

macOS has no public API that reads or requests System Audio Recording consent, so
`system_audio` is always `unknown`. `--request system_audio` briefly runs a process tap,
which makes macOS show the consent prompt if the user has not decided yet. Without consent a
capture still runs but the system stream is digital silence; the only positive signal is
non-zero system audio during a capture.

## `capture`

Control: JSON lines on **stdin**. Data: framed binary on **stdout**. Human logs on
**stderr**, never stdout. On stdin EOF the helper stops and exits 0, so it cannot
outlive its parent. SIGTERM, SIGINT and SIGHUP stop it the same way. If stdout is closed
(EPIPE) it exits 0 without writing anything further.

A process runs at most one capture session: `stop` (or EOF) ends the session and the
process.

### Commands (stdin, one JSON object per line)

```json
{"cmd": "start", "mic": {"enabled": true, "device_uid": null, "voice_processing": true}, "system": {"enabled": true}}
{"cmd": "set_mic", "device_uid": "BuiltInMicrophoneDevice"}
{"cmd": "stop"}
```

`device_uid: null` means "follow the system default input", including when the
default changes mid-capture. `voice_processing` enables Apple's voice-processing IO
(echo cancellation, noise suppression) on the mic path so the far side's voice
playing through the laptop speakers is not re-transcribed as "me".

Voice processing always captures the **system default input**; macOS ignores a device
selection while it is on. So it is applied only when the selected device is the current
default. With another device the helper captures that device without voice processing.
The mic descriptor in `started` / `mic_changed` reports what is actually running,
including `voice_processing`.

All fields shown are required, except that `device_uid` may be `null` and a mic with
`"enabled": false` needs no other fields. Unknown fields are ignored. A malformed or
out-of-place command (a second `start`, `set_mic` without a running mic) produces an
`error` event with source `control` and code `invalid_command` and is otherwise ignored.

### Frames (stdout)

Every frame is `type:u8 | length:u32 LE | payload[length]`.

| type | payload |
|---|---|
| `0x01` AUDIO | `source:u8` (0 = mic, 1 = system) · `sample_index:u64 LE` · PCM `s16le`, mono, 16 kHz |
| `0x02` EVENT | UTF-8 JSON object with an `"event"` key |

`sample_index` is the position of the chunk's first sample on a **shared 16 kHz
timeline** whose zero is the host time at which `start` was processed. It is
derived from each buffer's `AudioTimeStamp.mHostTime`, not from counting samples,
so the two sources stay aligned even if one stalls. A consumer MUST treat a jump
forward as silence (zero-fill) and MUST tolerate — by trimming — a chunk that starts
before the end of the previous chunk from the same source (the helper keeps
overlap within a few ms but does not guarantee zero).

No audio frame precedes `started`. If stdout is not read, the helper buffers up to 10 s of
audio per source, then drops newer audio (a gap in `sample_index`) and reports it with an
`error` event (code `internal`) once writing resumes.

Events:

```json
{"event": "started", "t0_unix_ms": 1790000000000, "mic": {"uid": "...", "name": "MacBook Pro Microphone", "voice_processing": true}, "system": true}
{"event": "mic_changed", "mic": {"uid": "...", "name": "...", "voice_processing": false}}
{"event": "error", "source": "mic" | "system" | "control", "code": "permission_denied" | "device_unavailable" | "invalid_command" | "internal", "message": "...", "fatal": false}
{"event": "stopped"}
```

`started` is the first frame of a session. Its `mic` is `null` when the mic is disabled
or not capturing yet (permission prompt pending, denied, no device); `system` is `false`
when system capture is disabled or failed to start. Failures that happened while starting
follow `started` as `error` events.

`mic_changed` is sent whenever the mic starts capturing with a different device or
`voice_processing` state than last announced: after `set_mic`, after the default input
changes (when following it), and when the mic recovers after an error.

A non-fatal error on one source leaves the other running. The helper currently never
sends `fatal: true`; an unrecoverable failure ends the process. `stopped` is always the
last frame before a clean exit.

## `watch`

Reports which apps are using a microphone, for meeting detection. Output is JSON lines on
stdout: one event on start, then one whenever the set of apps changes.

```json
{"event": "mic_apps", "apps": [{"pid": 4242, "name": "zoom.us", "bundle_id": "us.zoom.xos"}]}
```

Each entry is a regular (Dock) app. Helper processes that hold the mic, such as a browser's
audio service, are reported as the app that owns them, found by walking parent
processes. Background daemons with no owning app, such as CoreSpeech, are omitted, as is the
app that spawned the helper. The helper polls Core Audio's process list once per second.
It exits on stdin EOF, SIGTERM, SIGINT or SIGHUP, like `capture`.

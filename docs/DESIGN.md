# Design decisions: desktop app

Each entry names the choice, the alternatives considered, and why this one
won. Server and native-helper decisions are in `server/README.md` and
`native/README.md`.

## Process architecture

**Electron + React, with a Swift helper process for OS capture.**
Granola itself is Electron, and matching its look pixel for pixel is far
easier with the same web rendering. Alternatives: SwiftUI (native feel, but
every Granola visual detail would be a reimplementation, and ScrollView/TextKit
fidelity is weaker), and Tauri (smaller, but WKWebView has no ScreenCaptureKit or
Core Audio tap access either, so it still needs a native sidecar, and its text
rendering differs from Chromium's). The helper is a child process rather than a
Node addon: no Electron ABI coupling, crash isolation, TCC attribution to the app
bundle, and it can be run by hand. See `docs/protocol-helper.md`.

**The main process owns all state; the renderer is a view.** SQLite, the
recording session, the transcription sockets, LLM calls and the tray all live in
main. The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node) and
talks through one typed contract. Alternative: run transcription sockets in the
renderer via Web APIs. Rejected because a renderer can be throttled or reloaded
mid-meeting, and the tray and floating overlay need the same live state.

## IPC

**One contract file (`src/shared/ipc.ts`) and a Proxy-generated client.**
`Api` declares every method once. Main implements `Implementation<Api>` (the
compiler rejects a missing method), and the renderer gets `Async<Api>`.
Channel names are derived (`notes:list`), so there are no string constants to
drift. Push events (`Events`) are typed the same way. Alternatives were tRPC
(an extra dependency and abstraction for a two-endpoint system) and hand-written
channels (the usual source of drift bugs).

**Reads are cached with TanStack Query and invalidated by push events.** Main
emits `notes:changed`, `folders:changed` and similar after every mutation, and
the renderer invalidates exactly those keys. No polling, no manual cache
patching. High-rate streams skip the cache: chat tokens and transcript segments
render straight from their events, because refetching a thread 20 times a
second would be wasteful.

## Storage

**`node:sqlite` rather than better-sqlite3.** Both are synchronous and fast.
`node:sqlite` loads unmodified in Electron's Node 24 and in plain Node for unit
tests, which avoids the classic dual-ABI native-module rebuild. The API is
marked experimental, so it is confined to `db/database.ts` (~70 lines).

**Schema.** Notes store the user's editor document as ProseMirror JSON (lossless
round-trips), plus a plain-text projection for search and prompts. Enhanced
notes are stored as Markdown: the LLM produces Markdown, and the editor converts
edits back with `docToMarkdown`. Transcript segments are rows keyed by a stable
segment id with `INSERT OR IGNORE`, so a replayed final can never be stored
twice. Echo-suppressed mic segments are kept with `suppressed = 1` for
debugging, but excluded from every read. Migrations are an append-only array
indexed by `PRAGMA user_version`.

**Search is SQLite FTS5.** Title, notes and transcript are indexed. User input
is tokenised and each token is quoted as a prefix term, so FTS syntax in a query
(`NEAR`, `-`, quotes) is inert. The search box ANDs terms. Chat retrieval ORs
them and lets bm25 rank. Embeddings were considered and rejected for now: a few
hundred meetings fit comfortably in bm25-plus-recency, and embeddings would add
a model dependency.

## Transcription pipeline (`src/main/transcription`)

**Two channels, one clock.** The helper stamps every chunk with a sample index
on a shared 16 kHz timeline derived from host time. `SourcePipe` zero-fills
small gaps (≤1 s), re-anchors the stream clock on large ones (pause, device
switch, helper restart), and trims overlaps. Server timestamps are stream-relative
sample counts, mapped back to wall time through those anchors. Wall-clock arrival
time is never used, so network jitter cannot reorder speech, and "me" and "them"
interleave correctly.

**Exactly-once finals across reconnects.** Each `WebSocketTranscriber` retains
audio from the end of the last final onward. After a drop it reconnects with
backoff, sends `start` with `offset_ms` set to that point, and replays. Finals
never overlap, so nothing is transcribed twice, and nothing before the last
final is needed again. The replay window is capped (10 min); if the server stays
down longer, the oldest audio is dropped and logged. Tested against a real
WebSocket server that drops mid-stream (`test/unit/stream.test.ts`).

**Segment ends are exclusive.** A segment ending exactly on a capture gap maps
through the anchor before the gap. A unit test caught the naive mapping
producing a 55-second segment.

**Echo suppression has two layers.** Without headphones, the far side comes out
of the speakers and into the mic. Layer 1 is acoustic: Apple voice-processing IO
in the helper (only possible on the default input device). Layer 2 is textual
(`echo.ts`): a mic final is held until the system side has caught up past it,
then compared by word-level LCS against overlapping system text. A match of 60%
or more is withdrawn; short utterances also require time overlap, because
"yeah" matches by chance. Suppressed interims are never shown. Alternative:
our own AEC using system audio as the reference signal. That is the "right"
DSP answer but a big project; VPIO plus the text layer covers the real failure.

**Providers sit behind one `Transcriber` interface** (`transcriber.ts`): `mark`,
`push`, `finalizeNow`, `end`, plus segment and state callbacks. Three backends
implement it:

- The self-hosted server, through `WebSocketTranscriber` with the Granola wire
  protocol. It runs on a GPU host or on the Mac itself (`server/scripts/run-local.sh`,
  Parakeet on MLX).
- Deepgram, through the same `WebSocketTranscriber` with a different `WsProtocol`.
  Deepgram sends `is_final` pieces, which are assembled into one segment and closed
  at `speech_final`, `UtteranceEnd` or a `Finalize` response, so the session sees
  the same interim/final shape as with our server.
- Google Cloud Speech-to-Text v2 (Chirp 3) over gRPC (`google.ts`). A streaming
  request ends after about five minutes, so the transcriber opens a new one at the
  first final after four minutes (forced at 4:50) and replays unfinalized audio
  into it.

The session, echo suppression and storage do not know which one is running.
Gemini Live was considered and left out: it is a conversational model that
transcribes as a side effect, gives no stable interim/final segmentation and no
word timing, and costs more per hour than Chirp. Google users get Chirp through
the same credentials.

**Recording lifecycle lives in `RecordingManager`.** One recording at a time.
Stopping waits for the last finals (bounded), reindexes search, then triggers
enhancement. Quitting mid-meeting delays quit up to 8 s for the same flush.

## LLM

**Three providers behind one streaming function** (`llm/client.ts`):

- `openai`: any Chat Completions endpoint. The self-hosted gpt-oss through the
  server's pass-through, Ollama on the Mac, vLLM, OpenAI, OpenRouter and Gemini's
  compatibility endpoint all speak it, so a hand-written client with a unit-tested
  SSE parser covers them without an SDK.
- `anthropic`: Claude through the official SDK, with Claude Opus 5 as the default.
  Refusal fallbacks are on for the models that support them, so a declined request
  is retried on a fallback model inside the same call instead of producing empty notes.
- `vertex`: Gemini on Vertex AI. Vertex speaks Chat Completions too, but needs
  short-lived OAuth tokens, which `google-auth-library` mints from a service-account
  file or `gcloud` application-default credentials. The same credentials serve
  Chirp transcription.

Settings has presets for the common endpoints, so a friend with an OpenAI key or a
GCP project fills in one field.

**Secrets are encrypted at rest.** API keys and the server token go through
Electron `safeStorage` (a key held in the macOS Keychain) before they reach SQLite,
stored with an `enc:v1:` prefix. Plaintext values from older versions are read and
re-sealed on the next write.

**Prompts are pure functions (`llm/prompts.ts`).** Enhancement gets the
template, the user's own notes ("every point they wrote must appear") and a
speaker-labelled, timestamped transcript. Over budget, the middle of the
transcript is elided rather than the end, because openings and conclusions carry
the decisions. Chat is grounded in the current note, or in bm25-ranked plus
recent notes under a character budget.

## Meeting detection

**Mic use is the signal.** `granola-helper watch` reports which apps hold the
microphone, walking helper processes up to the regular app that owns them (a
browser tab's audio process reports as the browser). When Zoom, Meet in a browser,
Teams or similar starts using the mic, a prompt slides in from the right edge of
the screen. If a calendar event with a meeting link is on now, the prompt offers to
join it and the note takes that event's title and attendees. Zoom and Meet do not
expose participant emails to other apps, so people and companies come from the
calendar invite matched to the call. Dismissing a prompt quiets that app for ten
minutes; "Don't detect meetings in {app}" is permanent and reversible in Settings.

**Speaker names come from the invite.** The mic channel is always "Me". The system
channel carries everyone else, so it gets a name only when the invite has exactly
one other person; with more, it stays "Them" rather than guessing. The name is
used in the transcript panel, the transcript tab, copied text and the prompts, so
enhanced notes attribute points to the right person.

## UI

**Fidelity is measured, not eyeballed.** The reference screenshots are cropped
to the window (1198×838 pt at 2×). `test/visual/capture.spec.ts` renders the same
screens with matching fixture data, and each pair is diffed as side-by-side
images plus a red/cyan overlay. That pass found, for example, that active nav
items keep the secondary text colour, that nav text is 14 px not 15 px, and that
the calendar list uses 50 pt rows. The private fixture (real names from the
screenshots) is gitignored.

**Fonts.** Granola sets its UI in KMR Melange Grotesk and its titles in
Quadrant Notepad. Both are commercial, so neither is in this repository. When
Granola is installed, the clone loads them from Granola.app's own bundle
(`src/main/fonts.ts` serves them through a read-only `granola-font:` scheme), so
text matches exactly. Without Granola, the stacks fall back to Inter Tight, the
open font that measured closest to Melange's set-width, and IBM Plex Serif. The
book weight is 440, as Granola sets it.

**Tokens, not colours.** Every colour is a semantic CSS variable taken from
Granola's "oats" palette and checked against sampled screenshot pixels. Both
light and dark themes follow from the same tokens.

**Plain CSS Modules.** No Tailwind: exact pixel values dominate this work, and
co-located module files keep them readable.

**Editor: TipTap (ProseMirror).** It is the de facto rich-text engine and what
Granola uses. "/" opens templates through TipTap's suggestion plugin. Choosing
one inserts the template's section headings, and the full template guides
enhancement.

**Routing is a typed stack in zustand.** The app has no shareable URLs (deep
links go through the main process), and Granola's back pill shows the previous
screen's icon, which falls straight out of a route stack.

## Honest gaps versus Granola

These are the parts of Granola that need its cloud and have no local
equivalent:

- Sharing with other accounts and "Shared with me": always empty.
- Billing, referrals and workspace members: informational only.
- Recipe usage counts start from Granola's published numbers and increment
  locally.
- Company names are domains, and logos are fetched from the company's own domain
  (no enrichment service).

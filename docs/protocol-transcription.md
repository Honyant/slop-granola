# Transcription service protocol (v1)

The desktop app talks to any server that implements this document. The reference
implementation lives in `server/` and runs on a GPU host on the tailnet, or on the Mac itself.

Design constraints, in priority order:

1. **Transcript quality.** Final text comes from the most accurate model we can host.
2. **Latency of feedback.** The user should see words within ~0.5 s of saying them.
3. **Timestamps on one clock.** Every timestamp is derived from the audio sample
   index, never from wall-clock time on either side, so network jitter cannot move
   text around.
4. **Dumb clients.** Segmentation, VAD and model choice live on the server. The client
   only ships PCM and renders what comes back.

## Transport

`GET /v1/listen` upgraded to WebSocket. One connection carries exactly one mono
audio stream. The app opens one connection per source (`mic`, `system`); the
server never needs to know which is which.

Why one connection per source rather than multiplexing: connections fail
independently (the system tap can die while the mic keeps going), the server stays
stateless across streams, and GPU work for two streams parallelises naturally.

Authentication: `Authorization: Bearer <token>` header. `?token=<token>` is also
accepted because browser WebSocket clients cannot set headers. Missing or wrong
token → HTTP 401 before upgrade.

## Client → server

First message MUST be a text frame:

```json
{"type": "start", "sample_rate": 16000, "encoding": "pcm_s16le", "language": "en", "offset_ms": 0, "interim_results": true}
```

- `sample_rate`: only 16000 is required to be supported.
- `encoding`: only `pcm_s16le` (little-endian signed 16-bit, mono) is required.
- `language`: BCP-47 primary tag or `"auto"`.
- `offset_ms`: added to every timestamp the server emits. A client that reconnects
  mid-meeting sets this to the stream position it resumes from, so timestamps stay
  continuous across connections.

Subsequent frames:

| Frame | Meaning |
|---|---|
| binary | Raw PCM in the negotiated encoding. Any length; 20–100 ms recommended. |
| `{"type":"finalize"}` | Close the open segment now and emit its `final` (used on mic switch / pause). |
| `{"type":"keepalive"}` | No-op. Clients send one every 10 s when not streaming audio. |
| `{"type":"end"}` | No more audio. Server flushes, sends all remaining `final`s, then `closed`, then closes the socket with code 1000. |

## Server → client

All text frames, JSON.

```json
{"type": "ready", "session_id": "…", "models": {"interim": "…", "final": "…"}, "sample_rate": 16000}
{"type": "interim", "segment_id": "a1f3-7", "start_ms": 12040, "end_ms": 13880, "text": "we work with organ"}
{"type": "final",   "segment_id": "a1f3-7", "start_ms": 12040, "end_ms": 15210, "text": "We work with organizations like Airbus."}
{"type": "error",   "code": "bad_request", "message": "…", "fatal": true}
{"type": "closed"}
```

Semantics:

- A **segment** is one VAD utterance. `segment_id` is an opaque string, unique within
  the connection.
- Zero or more `interim`s precede exactly one `final` for the same `segment_id`.
  Each `interim` replaces the previous one wholesale (it is not a delta).
- A `final` is immutable. Segments are emitted in `start_ms` order and never overlap.
- Messages are strictly ordered by segment: everything about segment N (its interims
  and its final) is sent before anything about segment N+1.
- A segment whose final text is empty (silence or noise that got past VAD) is not
  reported at all, **unless an interim for it was already sent**: then its `final`
  arrives with `"text": ""`, meaning "remove this segment". Without this rule a
  suppressed final would leave its last interim on screen forever.
- `error.code` ∈ `unauthorized | bad_request | overloaded | internal`. `fatal: true`
  means the server will close the socket; the client should reconnect with backoff.
  A non-fatal `internal` error (the final model failed on one segment) is followed by
  that segment's retraction if an interim had been shown; the stream continues.
- Under load the server may drop `interim`s. It never drops `final`s.

Timeouts and close codes:

- The `start` message must arrive within 10 s of the upgrade.
- A connection that sends nothing (no audio, no `keepalive`) for 30 s gets a fatal
  `bad_request` error and is closed.
- Close codes: `1000` after `closed`; `1008` after a fatal `bad_request`; `1011`
  after a fatal `internal`; `1013` after `overloaded` (sent right after the upgrade,
  before `ready`, when the server is at its stream limit).

## Auxiliary HTTP endpoints

- `GET /healthz` → `{"ok": true, "models": {...}, "device": "cuda:0"}` (no auth).
- `POST /v1/transcribe` (auth) body = WAV file (any rate, mono or stereo) →
  `{"segments": [{"start_ms", "end_ms", "text"}], "model": "…"}`. Offline
  re-transcription of a whole recording with the final model. Timestamps are relative
  to the start of the file. Undecodable input → HTTP 400 with an `error` body.
  Offline work runs at lower priority than live streams, so it slows down rather than
  delaying live finals.
- `POST /v1/chat/completions`, `GET /v1/models` (auth) → OpenAI-compatible
  pass-through to the host's LLM runtime (Ollama), streaming supported. This lets the
  app reach the LLM through the same tailnet port and token.

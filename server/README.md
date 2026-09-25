# granola-asr

Streaming transcription server for the Granola clone. It implements
[`docs/protocol-transcription.md`](../docs/protocol-transcription.md). Run it in Docker on
an NVIDIA GPU host (developed on an RTX 5090, reached over Tailscale), or natively on an
Apple Silicon Mac with `scripts/run-local.sh`.

- Interim text comes from **NVIDIA Parakeet-TDT-0.6B-v3**, re-decoded every 480 ms of speech.
- Final text comes from **IBM Granite Speech 4.1 2B**.
- Silero VAD segments the stream on the server.
- The same port proxies the host's Ollama through an OpenAI-compatible API.

## Quick start

```sh
GRANOLA_DEPLOY_HOST=gpu-box ./deploy.sh       # rsync, docker build, restart, wait for /healthz, write .env.local
set -a; . ./.env.local; set +a
curl http://<host-tailnet-ip>:8765/healthz
python scripts/stream_wav.py "$GRANOLA_ASR_URL" talk.wav --reference talk.txt
```

`deploy.sh` is idempotent. The first run on a host generates the bearer token and stores it
in `~/.config/granola-asr/env` (mode 600). Later runs reuse that token and rewrite
`.env.local` (gitignored) from it. To rotate the token, delete that file on the host and
redeploy.

Local development (no GPU needed for the tests):

```sh
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e ".[dev]"
.venv/bin/python -m pytest -q          # 60 tests, about 1 s
```

## Layout

| path | what |
|---|---|
| `granola_asr/segmenter.py` | VAD state machine over sample indices: padding, min-silence close, max-length split, interim cadence |
| `granola_asr/vad.py` | Silero VAD v6 through ONNX Runtime, one shared session and per-stream state |
| `granola_asr/engine.py` | the single GPU worker thread and its priority queues (finals > interims > batch) |
| `granola_asr/session.py` | one WebSocket stream: a reader (VAD, job submission) and an emitter (ordered outbox) |
| `granola_asr/recognizers.py` | the two production models, the output budget and the fallback |
| `granola_asr/text.py` | empty-text detection and the sentence-case fix |
| `granola_asr/protocol.py` | message parsing and construction |
| `granola_asr/app.py` | routes: `/v1/listen`, `/healthz`, `/v1/transcribe`, the LLM proxy; auth; session limit |
| `granola_asr/offline.py`, `llm_proxy.py`, `auth.py`, `config.py` | what the names say |
| `tests/` | segmenter, engine and protocol tests with a fake VAD and fake recognizers |
| `scripts/stream_wav.py` | end-to-end client: streams a WAV in real time and reports lag and WER |
| `eval/eval_asr.py`, `eval/summarize.py`, `eval/results/` | the model evaluation below, including every hypothesis |

### How a stream flows

```
client PCM ──► reader: decode s16 ─► Segmenter.feed (Silero VAD, inline) ─► events
                 │ InterimReady(u) ─► engine.submit_interim (replaces any pending one for this stream)
                 │ UtteranceClosed(u) ─► engine.submit_final ─► outbox.put(pending final)
GPU worker thread: pops finals first, then interims (one per stream, oldest first), then batch
emitter: outbox in order; awaits each pending final before sending anything queued after it
```

An interim result reaches the outbox only if its segment is still open when the result
arrives. That check runs on the event loop thread, the same thread that closes segments, so
there is no race. As a result, every message about segment N is on the wire before anything
about segment N+1.

## Model choice

The eval draws 500 utterances with a fixed seed: 300 from the AMI IHM test set (meetings)
and 200 from Earnings-22 test (calls), as packaged in `hf-audio/open-asr-leaderboard`. Each
model runs at batch size 1 on the RTX 5090 in bf16 (Whisper in fp16), because the streaming
path always decodes one segment at a time. Autoregressive models use a static KV cache (see
the design decisions).

- **WER** uses the Whisper English normaliser, as the Open ASR leaderboard does.
- **Formatted WER** keeps case and treats `. , ? !` as words, so it measures readability.
  The absolute values are high because human references punctuate inconsistently; compare
  models against each other, not against zero.
- **Latency** is the median of 5 runs on a clip of that length.
- **Silence and noise columns** show what each model outputs for 3 s of digital silence and
  for 3 s of white noise at -40 dBFS.

Reproduce with `python eval/eval_asr.py --model <name> --out eval/results` (about 1 to 3
minutes per model), then `python eval/summarize.py eval/results`.

| model | WER AMI | WER E22 | WER all | formatted WER AMI / E22 | latency 3 s / 6 s / 12 s / 25 s (ms) | RTFx | peak VRAM (GiB) | cased / punct. | on 3 s silence | on 3 s noise |
|---|---|---|---|---|---|---|---|---|---|---|
| granite-speech-5.0-470m-turboctc | 8.73 | 7.55 | 7.99 | 46.1 / 36.0 | 20 / 20 / 20 / 20 | 223 | 0.9 | 0% / 2% | 'the' | 'thank' |
| **granite-speech-4.1-2b** (final) | 8.92 | 7.88 | 8.27 | 23.1 / 14.2 (**18.0 / 14.1** with `sentence_case`) | 95 / 148 / 214 / 677 | 20 | 4.5 | 84% / 69% | 'It is the only one in the world.' | 'Ellos son los que se encuentran en la parte superior de la imagen.' |
| qwen3-asr-1.7b | 10.31 | 9.74 | 9.95 | 25.9 / 25.1 | 104 / 142 / 367 / 689 | 20 | 4.1 | 99% / 99% | "So, I'm going to be talking about the different types of business." | 'Okay.' |
| qwen3-asr-0.6b | 10.78 | 10.88 | 10.84 | 24.7 / 26.1 | 69 / 90 / 246 / 516 | 23 | 1.7 | 99% / 99% | "I'm." | 'The.' |
| **parakeet-tdt-0.6b-v3** (interim) | 12.17 | 10.38 | 11.05 | 20.3 / 25.1 | 59 / 80 / 166 / 326 | 55 | 1.3 | 98% / 92% | '' | '' |
| whisper-large-v3 | 14.35 | 10.80 | 12.13 | 27.2 / 24.7 | 80 / 96 / 262 / 516 | 36 | 3.5 | 89% / 92% | 'you' | '.' |
| whisper-large-v3-turbo | 15.56 | 11.02 | 12.72 | 28.5 / 25.4 | 38 / 44 / 86 / 172 | 84 | 1.9 | 89% / 93% | 'you' | '.' |

Not evaluated:

- **Cohere Transcribe** is gated, and this HF account has not accepted its license.
- **NVIDIA canary-qwen-2.5b** and **parakeet-tdt-0.6b-v2** only load through NeMo. I didn't
  want to put a second framework into the image while transformers-native models of similar
  published accuracy were available.
- **granite-speech-4.1-2b-plus** and **-nar** don't output punctuation, according to their
  model cards.

Why these two:

- **Final model, Granite Speech 4.1 2B:** it has the lowest WER of any model that also outputs
  casing and punctuation: 8.3% against 10.0% for Qwen3-ASR-1.7B and 11.1% for Parakeet.
  - Its weakness is on AMI. It returns 56 of 131 meeting utterances of six or more words
    with no punctuation at all (Qwen3: 0, Parakeet: 6). `text.sentence_case` capitalises
    such an output and closes it with a period, since a VAD utterance is roughly a sentence.
    That lowers Granite's AMI formatted WER from 23.1 to 18.0, the best in the table; it
    changes the other models by ±0.5 at most.
  - Granite was trained on the AMI and Earnings-22 *training* sets, according to its model
    card. The test sets used here are disjoint, but its advantage on these two domains may
    be somewhat larger than on arbitrary meetings.
- **Interim model, Parakeet-TDT-0.6B-v3:** it runs in 60 to 170 ms on 3 to 12 s segments,
  outputs casing and punctuation, and returns nothing on silence and noise.
  - granite-speech-5.0-turboctc is faster (20 ms flat) and more accurate, but its output
    is lowercase and unpunctuated. Every segment would visibly change style when its final
    replaced the interim, and it outputs words on pure noise.

The service uses 6.5 GB of VRAM (per `nvidia-smi`). With `gpt-oss:latest` loaded in Ollama the
whole GPU sits at 20.5 GB of 32 GB, and Ollama stays 100% on the GPU.

**LLM context.** Ollama loads gpt-oss with an 8k context, and its OpenAI-compatible API can't
raise `num_ctx` per request, so a long meeting's transcript would be silently truncated.
`deploy.sh` therefore creates `granola-gpt-oss` from `ollama/granola-gpt-oss.Modelfile`: an
additive alias of `gpt-oss:latest` with the model's full 131072-token context (same weights, no
extra disk). The app uses it. With the ASR service loaded the GPU sits at 23.6 of 32.6 GB, and
Ollama stays 100% on GPU. A 23.7k-token prompt arrives whole and starts streaming in 2.9 s.
A needle planted at the top of a 16.7k-token prompt was recalled.

**Multilingual.** Parakeet v3 auto-detects 25 European languages. Granite 4.1 transcribes
English, French, German, Spanish, Portuguese and Japanese. The `language` field in `start`
is accepted but not used, because both models detect the language themselves. English is
the only language I evaluated.

## End-to-end results (deployed server, streamed from the Mac over the tailnet)

The test clips are reconstructed from real recordings, with references, by a small script
using the same datasets:

- **AMI ES2004b**, 300 to 540 s: all speakers placed at their true offsets, with
  overlapping utterances dropped so that the reference order is well defined. 4 min, 35
  utterances.
- **Earnings-22 call 4432298**, chunks 0 to 28, contiguous. 3 min, one speaker at a time.

Both clips were streamed at the same time, in real time, in 40 ms frames (two sessions,
like the app's mic and system streams):

```
python scripts/stream_wav.py "$GRANOLA_ASR_URL" ami_ES2004b_4min.wav --reference ami_ES2004b_4min.txt
python scripts/stream_wav.py "$GRANOLA_ASR_URL" e22_4432298_3min.wav --reference e22_4432298_3min.txt
```

| clip | WER | interim lag p50 / p90 / max | final lag p50 / p90 / max |
|---|---|---|---|
| AMI meeting, 4 min | 6.70% | 137 / 258 / 444 ms | 638 / 834 / 1161 ms |
| Earnings call, 3 min | 15.70% | 142 / 262 / 478 ms | 750 / 931 / 4135 ms |
| AMI meeting, 4 min, while gpt-oss streams completions nonstop on the same GPU | 6.70% | 202 / 424 / 947 ms | 700 / 1125 / 1297 ms |

Lag is the time the message arrived minus the time the audio at its `end_ms` was sent.

- A final's lag includes the 400 ms the segmenter waits before closing an utterance
  (600 ms of silence minus the 200 ms of post-padding that belongs to the segment).
- The Earnings-22 maximum is a 25 s monologue closed by the max-length split. Its final
  cannot be sent until the split happens, which can be up to 5 s after the cut point.
  Inference for that segment took 620 ms.
- The Earnings-22 WER is mostly the reference. Its transcript is non-verbatim: it drops
  repetitions ("let us now let us now let us now") and has its own mistakes ("cyber
  functionability" where the audio says "Cyberpunk stability"). The model's real misses
  are proper names.

Measured separately: per-final GPU time on the deployed server (from the engine log) is
110 to 620 ms for 1 to 22 s segments. Silero VAD costs 113 µs per 32 ms frame, 0.35% of a
core per stream.

## Design decisions

**Silero VAD thresholds: 0.5 to open, 0.35 to stay in speech.** This is Silero's own
recommended hysteresis. A single threshold chops utterances apart at soft syllables; a
lower opening threshold opens segments on breaths and keyboard noise.

**600 ms of silence closes an utterance.** Conversational pauses inside a sentence are
mostly under 500 ms. Waiting longer only delays finals: every 100 ms of wait adds 100 ms to
every final. The tests pin down the boundary (500 ms keeps one utterance, 700 ms splits it).

**300 ms pre-padding and 200 ms post-padding.** VAD fires one or two 32 ms frames after
speech actually starts, and word-initial fricatives and plosives are quiet. 300 ms keeps
them. The post-pad keeps trailing sounds and must be shorter than the silence wait, so it
is always audio the server already has. Pre-padding is clamped to the previous segment's
end, which is how the spec's no-overlap guarantee holds.

**250 ms minimum speech.** Blips shorter than that (clicks, a cough) are dropped before
they reach a model. That is the first line of defence against hallucinated finals, and it
matters because Granite and Qwen both invent sentences on non-speech (see the table).

**25 s maximum segment, split at the quietest 32 ms frame in the last 5 s.** Granite's
latency is about linear in output length, and the eval shows 25 s costs about 0.7 s. The
5 s search window almost always contains a breath pause. The two parts are contiguous
(`end == start`), so no audio is lost or duplicated.

**Interims every 480 ms of audio, and only once 250 ms of speech has been heard.** This is
the 400 to 600 ms cadence from the spec. The interim span is clipped to the post-padded end
of speech, so no interim is spent re-decoding trailing silence and an interim never ends
after its final.

**One GPU worker thread with strict priorities: live finals, then interims, then batch.**
The alternatives were one thread per model, or a pool, relying on CUDA stream priorities.
With a single thread, the priority rule is exactly the queue order, which makes it easy to
reason about and to test (`tests/test_engine.py`). The cost is that an interim can wait
behind one final, which takes at most about 0.7 s and usually about 0.2 s.

**Interims are coalesced per stream, and that is the whole backlog policy.** Each stream
has at most one pending interim job. A new request replaces the old one but keeps its queue
position, so a chatty stream cannot starve a quiet one. When the segment closes, its pending
interim is cancelled. The interim queue is therefore bounded by the number of streams, and
dropping only ever affects stale interims. Finals are never dropped.

**Ordered outbox per connection.** A final enters the outbox as a pending future when its
segment closes. The emitter awaits futures in order, so the wire order is the segment order
by construction. No reordering buffer is needed.

**Empty finals.** Text with no letter or digit counts as empty. An empty final is
suppressed unless an interim for that segment was already shown; then it is sent with
`""` to retract the interim. I changed the spec to say this: as originally written, a
suppressed final would have left its last interim on screen forever.

**Granite's output budget, with fallback to Parakeet.** Granite occasionally falls into a
repetition loop ("uh, uh, uh, ..."); it happened once in the 3 min earnings clip. Normal
speech produces 3 to 4 tokens per second, so generation is capped at 16 + 8 tokens per
second of audio. Hitting the cap raises `DegenerateOutput`, and that segment is decoded by
Parakeet instead. This fixes the text and caps how long a loop can hold the GPU.

**Static KV cache for Granite.** `cache_implementation="static"` lets `generate()` compile
the decoder step. Measured on 3 to 25 s clips it is 3.5x faster: a 25 s segment drops from
2.8 s to 0.76 s. A debugging note: importing the `silero_vad` package runs
`torch.set_num_threads(1)`, which invalidates every compiled graph and made the first final
after each start take 9.4 s. `vad.py` therefore locates the ONNX file without importing the
package.

**VAD runs inline on the event loop.** It costs 113 µs per frame, so a 40 ms client frame
blocks the loop for about 0.2 ms. Handing it to a thread would cost more than that in
scheduling. Offline `/v1/transcribe` runs the whole-file VAD in `asyncio.to_thread`,
because that takes seconds.

**Timestamps.** `ms = offset_ms + sample_index * 1000 // 16000`, using the count of
samples received since `start`. Nothing reads a clock.

**Auth.** `hmac.compare_digest` on the bearer token from `Authorization` or `?token=`. A
WebSocket with a bad token gets an HTTP 401 denial response before the upgrade, as the spec
requires. uvicorn runs with `ws="wsproto"`, because its default websockets-sansio backend
logs a spurious `ERROR` for every denial response.

**Liveness.** The server closes a stream that has sent nothing for 30 s. The protocol
already requires keepalives every 10 s, so a laptop that went to sleep frees its session
slot without waiting on TCP timeouts. `start` must arrive within 10 s.

**Admission control.** At most 8 concurrent streams (`GRANOLA_ASR_MAX_SESSIONS`); above
that, the server sends `overloaded` and closes with 1013. 8 streams is 4 meetings, and it
keeps the worst-case final queue in the hundreds of milliseconds.

**Offline transcription runs at the lowest priority.** A one-hour re-transcription is about
700 segments. At batch priority it only uses GPU time that live streams leave idle.

**LLM proxy.** Every response body is streamed through unchanged. SSE and plain JSON share
one code path, and nothing is buffered. The read timeout is disabled, because Ollama can
spend 30 to 50 s loading gpt-oss before the first byte.

**Docker, not systemd.** The image pins every dependency (`requirements.lock`, compiled by
`uv` for `cu130`). CUDA comes from the torch wheels, and the driver comes from the NVIDIA
CDI device. Running it needs these flags: `--restart unless-stopped`, `--network host`
(binding to the tailnet IP), `--user` set to the host user so that the mounted caches stay
owned by that user, the HF cache mounted from the host, and the torch compile cache mounted
so restarts reuse compiled kernels (a restart takes about 40 s). Once both models are
cached, `deploy.sh` sets `HF_HUB_OFFLINE=1`. Without it, a boot with no network yet stalls
for minutes in Hugging Face retry loops (measured in a container with `--network none`).

## Operations

- Logs: `ssh <host> docker logs -f granola-asr`. There is one line per final (audio length,
  queue wait, GPU time), a line for any interim or batch job slower than 1 s, and a warning
  whenever Granite degenerates.
- Configuration, as environment variables in `~/.config/granola-asr/env` on the host:
  - `GRANOLA_ASR_TOKEN`
  - `GRANOLA_ASR_HOST`, `GRANOLA_ASR_PORT`
  - `GRANOLA_ASR_INTERIM_MODEL`, `GRANOLA_ASR_FINAL_MODEL`
  - `GRANOLA_ASR_MAX_SESSIONS`
  - `GRANOLA_LLM_UPSTREAM`
- Restarts: a crash is restarted by Docker (tested by killing the process with `SIGKILL`).
  Docker is enabled at boot. If the tailnet IP isn't up yet when the container starts, the
  bind fails and Docker keeps retrying until it is. I haven't tested an actual reboot,
  because the host runs other services.
- LLM model name: Ollama on this host tags the 20B model `gpt-oss:latest`, and there is no
  `gpt-oss:20b` tag, so `.env.local` uses `gpt-oss:latest`.

## Known limitations

- **Hallucinations on non-speech:** non-speech that passes VAD (more than 250 ms of
  "speech-like" noise) can still get a made-up final from Granite; the table shows it does
  this on noise. VAD gating is the only filter. I haven't measured how often it happens on
  real meeting noise.
- **Punctuation within a segment:** the sentence-case fix adds only a capital and a final
  period. It can't insert commas or sentence breaks inside an unpunctuated segment.
- **Speakers:** there is no diarization within a stream. Mic versus system audio is the
  only speaker signal.
- **Interim waits:** an interim can wait behind one final on the single GPU worker, which
  shows up as the tail of the interim lag.
- **LLM contention:** Ollama and ASR share one GPU. Continuous LLM generation raises
  interim lag p90 from about 260 to 424 ms and final lag p90 from about 830 to 1125 ms (the
  last row of the end-to-end table).
- **Upload size:** `/v1/transcribe` holds the whole upload in memory and has no size limit.
  That is acceptable on a private tailnet and wouldn't be on the internet.

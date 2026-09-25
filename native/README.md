# granola-helper

The macOS helper that the Electron app spawns for microphone capture, system-audio capture
and EventKit. The contract with the app is [`docs/protocol-helper.md`](../docs/protocol-helper.md).

## Build, test, run

```sh
./build.sh                      # release arm64, ad-hoc signed with hardened runtime -> dist/granola-helper
swift test                      # unit tests (no audio hardware or permissions needed)
scripts/smoke.sh                # build, then run the capture integration test (plays speech on the default output)
python3 scripts/echo_probe.py --volume 50   # voice-processing echo measurement (unmutes and plays speech aloud)

dist/granola-helper devices
dist/granola-helper permissions
echo '{"cmd":"start","mic":{"enabled":true,"device_uid":null,"voice_processing":false},"system":{"enabled":true}}' \
  | dist/granola-helper capture | xxd | head
```

Requirements: Xcode 15.2 or later (Swift 5.9, macOS 14.2 SDK), deployment target macOS 14.2.
The integration scripts need Python 3 with numpy.

## Layout

| Path | Contents |
|---|---|
| `Sources/HelperCore/` | Everything testable without hardware: framing, timeline math, resampling, the frame ring, the writer thread, command parsing, event encoding. |
| `Sources/granola-helper/` | The executable: Core Audio tap, AVAudioEngine mic, HAL helpers, the capture session, and the one-shot subcommands. |
| `Sources/CAtomics/` | Acquire/release loads and stores for the ring's counters (Swift 5.9 has no standard atomics). |
| `Tests/HelperCoreTests/` | XCTest unit tests. |
| `scripts/` | `smoke.py` / `smoke.sh` (capture integration test), `echo_probe.py` (voice-processing measurement), `helper_protocol.py` (frame parser shared by both). |
| `granola-helper.entitlements` | Microphone and calendar entitlements, required under the hardened runtime. |

## Architecture and threading

```
                 stdin reader thread ──lines──┐
 SIGTERM/INT/HUP (dispatch sources) ──────────┤
 HAL property listeners, AVAudioEngine        ▼
 notifications, permission callbacks ──> main queue: CaptureSession, MicSource,
                                          SystemAudioSource (all control state)
                                                │ creates / stops
              ┌─────────────────────────────────┴───────────────────────────┐
              ▼                                                             ▼
  HAL IO thread: ProcessTapCapture IOProc        AVAudioEngine tap thread: MicCapture block
      StreamEncoder.process                          StreamEncoder.process
      (downmix, resample, stamp)                     (downmix, resample, stamp)
              │ FrameRing (SPSC, lock-free)                  │ FrameRing
              └──────────────────────┬───────────────────────┘
                                     ▼
                     writer thread: FrameWriter ──> stdout (only writer of fd 1)
                     also writes events queued by the main queue
```

There are four kinds of thread, and each piece of state belongs to exactly one:

- **Main queue** (`dispatchMain()`): all control state. Commands from stdin, signals, HAL
  listeners (registered on the main queue), engine configuration notifications and
  permission callbacks all arrive here, so none of that state needs a lock.
- **Audio threads**: the HAL IO thread for the system tap and AVAudioEngine's tap thread for
  the mic. Each runs one `StreamEncoder`
  ([StreamEncoder.swift:29](Sources/HelperCore/StreamEncoder.swift#L29)), which downmixes,
  resamples, timestamps, and publishes complete frames into that stream's `FrameRing`. Nothing
  on this path allocates, locks, or does I/O.
- **Writer thread** ([FrameWriter.swift:79](Sources/HelperCore/FrameWriter.swift#L79)):
  sleeps on a semaphore that producers signal, then writes queued events and every ring's
  readable bytes to stdout. It is the only code that touches fd 1 during capture.
- **stdin reader thread**: blocking `readLine`, forwarding each line to the main queue; EOF
  triggers shutdown.

Key files:

- Capture lifecycle, start ordering and shutdown: [CaptureSession.swift:95](Sources/granola-helper/CaptureSession.swift#L95)
- System tap and aggregate device: [ProcessTap.swift:11](Sources/granola-helper/ProcessTap.swift#L11), IOProc at [ProcessTap.swift:81](Sources/granola-helper/ProcessTap.swift#L81)
- Rebuild on device change and app-process exclusion: [SystemAudioSource.swift](Sources/granola-helper/SystemAudioSource.swift)
- Mic engine: [MicCapture.swift:26](Sources/granola-helper/MicCapture.swift#L26); device, permission and voice-processing policy: [MicSource.swift:65](Sources/granola-helper/MicSource.swift#L65)
- Resampler: [MonoResampler.swift](Sources/HelperCore/MonoResampler.swift); timestamps: [Timeline.swift](Sources/HelperCore/Timeline.swift), [ChunkStamper.swift](Sources/HelperCore/ChunkStamper.swift)
- Bounded ring: [FrameRing.swift](Sources/HelperCore/FrameRing.swift)

### How `sample_index` is computed

1. At `start`, the session records `t0 = mach_absolute_time()` and the wall clock
   (`t0_unix_ms`).
2. Each input buffer's `AudioTimeStamp.mHostTime` (the capture time of its first frame) maps
   to a fractional timeline position: `(hostTime - t0) * numer / denom * 16000 / 1e9`, using
   `mach_timebase_info`. On Apple Silicon a tick is 125/3 ns, not 1 ns.
3. The resampler's output lags its input. After feeding `I` input frames and receiving `O`
   output samples, `I * 16000 / inputRate - O` samples are still in its filter. The first output
   sample of the next call therefore sits that many samples before the new buffer's position.
   The AudioToolbox converter's default priming makes output sample `k` correspond exactly to
   input time `k / 16000`, so no other offset is needed (a unit test places pulses within
   half a sample of where they were captured).
4. While that measurement agrees with the running sample count to within 5 ms, the chunk gets
   exactly the index where the previous chunk ended, so the stream stays contiguous. A larger
   disagreement (a stall, dropped IO cycles, clock drift building up) re-anchors the stream on
   the measurement, and the consumer sees a gap or an overlap as the protocol allows.

## Design decisions

**Tap-only private aggregate device.** Apple's sample and most open-source tap code put the
default output device into the aggregate as its main sub-device, next to the tap. Without it,
the aggregate has exactly one input stream (the tap's), so the IOProc never has to work out
which buffer is the tap when the output device also has inputs, such as a USB headset.
Nothing in it refers to an output device that can disappear. I tested it: the tap-only
aggregate clocks itself (512-frame cycles, 10.67 ms) and timestamps are valid.

**Excluding the app's whole process group, not only the parent.** The brief said to
exclude the helper and its parent. Electron does not play audio from its main process:
Chromium's audio service runs in a utility process, which is another child of the main
process. The helper therefore excludes its own process, its parent, and every other direct
child of its parent. When the parent is launchd (pid 1), "siblings" would be every app on
the machine, so only the helper itself is excluded. The list is recomputed whenever the HAL's
process list changes. Updating a running tap's description through
`kAudioTapPropertyDescription` fails with `kAudioDevicePermissionsError` (`'!hog'`,
observed), so a changed list means a new tap, which leaves a gap of about 75 ms. The list
changes only when one of the app's own processes starts or stops using audio. The smoke test
plays one clip from a sibling process to check the exclusion.

**Rebuild the tap when the default output device or the tap's format changes.** I did not
find out whether a tap-only aggregate keeps working across an output switch; rebuilding is
correct either way. It also covers the output device changing
sample rate, which would otherwise make the encoder read 44.1 kHz audio as 48 kHz. Measured
gap per rebuild: about 210 ms.

**Resample and downmix on the audio thread, before the queue.** The alternative is queueing
raw device-rate audio and converting on the writer thread. Converting first means the queue
holds finished 16 kHz frames. The 10 s bound is then the same number of bytes for every device
rate, the writer can `write()` straight out of the ring without copying,, and a stalled stdout
cannot delay conversion work. The cost on the IO thread is one averaging pass and one
converter call per buffer.

**AudioToolbox `AudioConverter` instead of `AVAudioConverter`.** The two share an engine.
`AVAudioConverter`'s input block is a Swift closure bridged to an Objective-C block on each
call, which allocates. The C API takes a function pointer and a context pointer, so nothing
is allocated per buffer. The converter handles at most 4096 input frames per call and buffers
the remainder until the next call (measured: a single 4800-frame call emitted only 1354 of
1600 samples). AVAudioEngine delivers 4800-frame buffers, so the encoder feeds input in
chunks of 4096 frames or fewer to avoid an extra 100 ms of latency.

**Downmix by averaging channels, done by the helper.** `AVAudioConverter` and
`AudioConverter` drop channels beyond the first unless told otherwise, and their downmix
coefficients are not documented. Averaging keeps a centred voice at its original level and
cannot clip. With voice processing on, the input node reports 9 channels, which I measured
to be sample-identical, so averaging returns the processed signal unchanged.

**Timestamps: host time with a continuity window.** Counting samples alone drifts from the
wall clock and cannot represent a stall. Stamping each chunk purely from its own host time
jitters by a sample, and the consumer's zero-fill and trim rules then turn each jitter into a
click. The 5 ms window keeps the stream contiguous and still re-anchors on real
discontinuities. Measured drift against the wall clock is below 1 ms per 10 s.

**One single-producer ring per stream, one writer thread.** A shared queue would need a
lock taken on the IO thread (priority inversion) or a multi-producer lock-free queue. A
`DispatchQueue` hop from the IO thread allocates. Each capture instance (each tap build and
each mic engine) gets its own `FrameRing`, so a late callback from a stopped AVAudioEngine can
only write into its own retired ring. The single-producer rule holds even across rebuilds.
Rings hold only complete frames, so the writer writes all readable bytes of one ring before
moving to the next, and frames from different sources never interleave mid-frame.

**Drop whole frames when a ring is full, report once writing resumes.** Blocking the IO
thread is not an option, and growing without limit is what the bound exists to prevent. The
producer counts dropped samples in an atomic; the writer turns new drops into an `error`
event after each drain. Because indices come from host time, dropped audio shows up as a gap.

**Audio is held until `started` is written.** Sources must start before `started` can say
what is running, but their first audio can arrive within milliseconds. The writer drains
rings only after `releaseAudio()`, which the session calls right after queueing `started`.
Errors raised while starting are held back and sent after `started`.

**A new AVAudioEngine per mic configuration.** Reconfiguring a running engine means dealing
with the input node's cached formats, which go stale when its device changes (installing a
tap with `outputFormat(forBus:)` after a device switch throws "Input HW format and tap format
not matching"). A fresh engine costs a few milliseconds plus the first 100 ms buffer.
Selecting a device on the input unit posts one `AVAudioEngineConfigurationChange` while the
engine keeps running, so the helper rebuilds only when a notification finds the engine
stopped. Rebuilding on every notification caused an endless restart loop.

**One `reconcile()` for the mic.** Start, `set_mic`, default-input changes, device-list
changes, engine configuration changes and the permission answer all call the same function.
It works out which device should be captured and whether voice processing applies, and
rebuilds only if that differs from what is running. Duplicate notifications are therefore
harmless, and every path announces changes and failures the same way.

**Voice processing only on the default input.** With voice processing enabled, the engine
ignores the device selection. I tried `kAudioOutputUnitProperty_CurrentDevice` before and
after enabling it, on the global and input scopes, and `AUAudioUnit.setDeviceID`; the
voice-processing aggregate's active sub-devices were always the built-in mic and speakers.
When the selected device is not the default, the helper captures it without voice processing
and reports `voice_processing: false`, since a wrong microphone is worse than no echo
cancellation. Voice processing also ducks other apps' audio by default, which would turn down
the meeting itself, so ducking is set to the minimum.

**stdout handling.** `SIGPIPE` is ignored, so a dead reader surfaces as `EPIPE` on the writer
thread and the helper exits 0 (the reader is gone and nobody can act on a status). `O_NONBLOCK`
is cleared on stdout at startup because the writer relies on blocking writes. Shutdown waits
at most 2 s for the final flush, because a parent that is alive but no longer reading would
otherwise keep the helper alive.

**System-audio permission is reported as `unknown`.** No public API reads or requests
`kTCCServiceAudioCapture`. Probing is not reliable: without consent the tap still runs and
delivers exact digital silence, and silence is also what you get when nothing is playing.
Non-zero samples do prove consent, so the app can treat audible system audio during a capture
as confirmation. `--request system_audio` runs a tap for one IO cycle. The tccd log shows
that this makes coreaudiod send a non-preflight `TCCAccessRequest` for the responsible app,
which is the request that shows the prompt. Reading the TCC database would work but needs Full
Disk Access, and the private TCC SPI was ruled out.

**Calendar details.** `permissions` maps EventKit's write-only access to `denied`, because
the helper only reads. `calendar list` marks `defaultCalendarForNewEvents` as `is_default`,
which the app shows as the primary calendar. Event `id` is `eventIdentifier@<occurrence start, unix seconds>`,
because every occurrence of a recurring event shares one `eventIdentifier`. Unknown ids in
`--calendars` are skipped (a saved selection may name a deleted calendar), and ranges longer
than four years are rejected because EventKit silently truncates them.

**Hardened runtime in local builds.** `build.sh` signs ad hoc with `--options runtime` and the
two entitlements the helper needs, so a missing entitlement fails locally rather than only in
the notarized build.

## What the app bundle must provide

TCC attributes the helper's requests to the responsible process, the Electron app. The app's
`Info.plist` needs `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and
`NSCalendarsFullAccessUsageDescription`. Without a usage string, TCC denies the request
without showing a prompt. I observed this for system audio from Ghostty, which has no
`NSAudioCaptureUsageDescription`: tccd logged `authValue=0, authReason=8`, and the tap
delivered silence.

## Measurements

Measured on a MacBook Pro (Apple Silicon, macOS 15.7), built-in mic and speakers.

**Timeline drift.** `scripts/smoke.py --duration 60`: the trend of delivery latency (arrival
time minus the wall time implied by `t0_unix_ms + sample_index / 16000`) was −0.23 ms per
10 s for the mic and −0.19 ms per 10 s for system audio. A 12 s run gave −1.85 and −0.29 ms.
No gaps or overlaps occurred in steady state; median delivery latency was 17 ms for the mic and
23 ms for system audio.

**Voice processing and speaker echo.** `scripts/echo_probe.py --volume 50`, two runs. Each
setting was measured with afplay speech on the built-in speakers and again in silence
(control). Correlation is against the played file; the control column shows the chance
level.

| | VP off | VP on | control (no playback) |
|---|---|---|---|
| peak waveform correlation | 0.171, 0.198 | 0.027, 0.026 | about 0.02 |
| 20 ms envelope correlation | 0.339, 0.369 | 0.166, 0.143 | 0.13 to 0.16 |
| mic RMS vs control run | +3.5, +5.3 dB | −4.9, −13.6 dB | |

Without voice processing the far side is clearly in the mic stream. With it, both
correlations fall to the level of the silent control, so the echo is gone as far as this test
can see. Two caveats: at 50 % volume the unprocessed echo was only about 4 to 5 dB above the
room noise (RMS comparisons are noisy for that reason; the correlations are the reliable
numbers), and louder playback or external speakers were not tested. Voice processing also
runs only on the default input, so the app still needs its own suppression whenever
`voice_processing` is reported `false`.

**Backpressure.** With stdout unread for 14 s, RSS stayed at 16 MB. The helper reported
`dropped 2816 ms` (system) and `dropped 2455 ms` (mic) once reading resumed. That matches
10 s of ring plus the 64 KB pipe buffer.

## Known limitations

- Voice processing is available only on the system default input (see above).
- After a failed system-tap rebuild the helper retries on the next device change; there is
  no event for "system audio resumed", so the app only notices the audio coming back.
- Rebuilds leave gaps: about 210 ms for the system tap, about 0.5 s for a mic switch.
- Mic audio arrives in 100 ms blocks (AVAudioEngine's tap granularity on macOS). An
  `AVAudioSinkNode` or a raw AUHAL would cut that to about 10 ms if latency ever matters.
- App-process exclusion covers the parent and its direct children. Grandchildren of the app
  are not excluded.
- On stop, the last ~0.7 ms held in the resampler's filter is not flushed.
- `fatal` is always `false`; an unrecoverable failure ends the process instead.

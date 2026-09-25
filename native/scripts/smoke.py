#!/usr/bin/env python3
"""Integration smoke test for `granola-helper capture`.

Plays synthesized speech with afplay, captures both sources, and checks the stream:
well-formed frames, `started` first and `stopped` last, both sources present, audible system
audio during playback, and sample_index tracking the wall clock. Writes the assembled
streams to WAV files for listening.
"""

import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helper_protocol import SAMPLE_RATE, assemble, play_detached, run_capture, write_wav  # noqa: E402

SPEECH = "This is the granola helper smoke test. The quick brown fox jumps over the lazy dog."
SIBLING_SPEECH = "This sentence should be excluded."


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", default=os.path.join(here, "..", "dist", "granola-helper"))
    parser.add_argument("--duration", type=float, default=12.0)
    parser.add_argument("--out", default=tempfile.mkdtemp(prefix="granola-smoke-"))
    args = parser.parse_args()

    speech = os.path.join(args.out, "speech.aiff")
    sibling_speech = os.path.join(args.out, "sibling.aiff")
    subprocess.run(["say", "-o", speech, SPEECH], check=True)
    subprocess.run(["say", "-o", sibling_speech, SIBLING_SPEECH], check=True)
    play_at, sibling_at = 1.0, 7.5
    start = {"cmd": "start", "mic": {"enabled": True, "device_uid": None, "voice_processing": False},
             "system": {"enabled": True}}
    # The second clip is played by a direct child of this script, i.e. a sibling of the
    # helper, which stands in for the app's own audio and must be excluded from the tap.
    capture, code, t_start = run_capture(
        args.helper, start, args.duration,
        actions=[(play_at, lambda: play_detached(speech)),
                 (sibling_at, lambda: subprocess.Popen(["afplay", sibling_speech]))],
        stderr_path=os.path.join(args.out, "helper.stderr"))

    failures = []

    def check(ok, message):
        print(("PASS " if ok else "FAIL ") + message)
        if not ok:
            failures.append(message)

    check(code == 0, f"exit status {code} after stdin EOF")
    order = capture.frame_order
    check(bool(order) and order[0] == "event:started", f"first frame is started (got {order[:1]})")
    check(bool(order) and order[-1] == "event:stopped", f"last frame is stopped (got {order[-1:]})")
    errors = [e for _, e in capture.events if e["event"] == "error"]
    check(not errors, f"no error events {errors}")
    started = next((e for _, e in capture.events if e["event"] == "started"), None)
    if started is None:
        return 1
    print(f"     started: mic={started['mic']} system={started['system']}")

    t0 = started["t0_unix_ms"] / 1000
    for source in ("mic", "system"):
        chunks = [c for c in capture.chunks if c.source == source]
        check(len(chunks) > 0, f"{source}: {len(chunks)} audio frames")
        if not chunks:
            continue
        signal, stats = assemble(capture.chunks, source)
        write_wav(os.path.join(args.out, f"{source}.wav"), signal)
        print(f"     {source}: {len(signal) / SAMPLE_RATE:.2f} s on the timeline, "
              f"gaps {stats['gaps']} ({stats['gap_samples']} samples), "
              f"overlaps {stats['overlaps']} ({stats['overlap_samples']} samples)")

        # Delivery latency = arrival time minus the wall time of the chunk's last sample.
        # Its trend over the run is the drift between sample_index and the wall clock.
        ends = np.array([(c.sample_index + c.samples) / SAMPLE_RATE for c in chunks])
        latency = np.array([c.received_at - t0 for c in chunks]) - ends
        steady = ends > 1.0  # skip device start-up
        slope, _ = np.polyfit(ends[steady], latency[steady], 1)
        drift_ms = slope * 10 * 1000
        print(f"     {source}: delivery latency ms min/median/max "
              f"{latency.min() * 1e3:.1f}/{np.median(latency) * 1e3:.1f}/{latency.max() * 1e3:.1f}")
        check(abs(drift_ms) < 50, f"{source}: sample_index drift vs wall clock {drift_ms:+.2f} ms per 10 s")

    system, _ = assemble(capture.chunks, "system")
    def system_rms(t0, t1):
        segment = system[int(t0 * SAMPLE_RATE): int(t1 * SAMPLE_RATE)].astype(np.float64)
        return float(np.sqrt(np.mean(segment ** 2))) if len(segment) else 0.0

    rms = system_rms(play_at + 0.5, play_at + 4)
    check(rms > 100, f"system audio audible during playback (RMS {rms:.0f} of 32767)")
    if rms == 0:
        print("     system audio is exact digital silence: the process tap delivers zeros when the "
              "responsible app lacks System Audio Recording permission")
    else:
        sibling_rms = system_rms(sibling_at + 0.3, sibling_at + 1.5)
        check(sibling_rms < 1, f"audio from a sibling process (the app) is excluded (RMS {sibling_rms:.1f})")

    mic, _ = assemble(capture.chunks, "mic")
    if rms > 100 and len(mic) >= len(system) // 2:
        # Speaker-to-mic path: the lag of mic behind system is acoustic + converter latency.
        n = min(len(mic), len(system))
        a, b = system[:n].astype(np.float64), mic[:n].astype(np.float64)
        spectrum = np.fft.irfft(np.fft.rfft(b, 2 * n) * np.conj(np.fft.rfft(a, 2 * n)))
        window = int(0.2 * SAMPLE_RATE)
        lags = np.concatenate([spectrum[-window:], spectrum[:window]])
        lag = (np.argmax(np.abs(lags)) - window) / SAMPLE_RATE * 1000
        corr = np.max(np.abs(lags)) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
        print(f"     mic lags system by {lag:.1f} ms (normalised correlation {corr:.3f}; "
              "meaningful only if the speakers are audible)")

    print(f"     WAVs and helper stderr in {args.out}")
    print("OK" if not failures else f"{len(failures)} check(s) failed")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())

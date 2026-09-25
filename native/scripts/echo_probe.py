#!/usr/bin/env python3
"""Measures how much of another app's speaker playback reaches the mic stream, with Apple
voice processing off and on.

For each setting it makes two captures: one while afplay plays synthesized speech through the
default output, and a control with no playback. Echo level is the mic RMS over the playback
window relative to the same window of the control run (voice processing changes the noise
floor, so each setting is compared with itself). Correlation with the played signal shows
whether what remains is the far side's speech. If voice processing leaves it well above the
control and correlated, the app needs its own echo suppression.
"""

import argparse
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helper_protocol import SAMPLE_RATE, assemble, play_detached, run_capture, write_wav  # noqa: E402

SPEECH = ("Hi everyone, thanks for joining. Let's go through the quarterly numbers first. "
          "Revenue grew twelve percent, mostly from the enterprise segment. "
          "Next, I'd like to talk about hiring plans for the second half of the year.")
PLAY_AT = 2.0  # voice processing takes about a second to start
FRAME = SAMPLE_RATE // 50  # 20 ms envelope frames


def volume_settings():
    out = subprocess.run(["osascript", "-e", "get volume settings"], capture_output=True, text=True, check=True).stdout
    fields = dict(part.strip().split(":") for part in out.strip().split(","))
    return int(fields["output volume"]), fields["output muted"] == "true"


def set_volume(level: int, muted: bool):
    subprocess.run(["osascript", "-e", f"set volume output volume {level}",
                    "-e", f"set volume output muted {'true' if muted else 'false'}"], check=True)


def read_wav(path):
    with wave.open(path) as wav:
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float64)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0


def envelope(x):
    frames = len(x) // FRAME
    return np.sqrt(np.mean(np.square(x[: frames * FRAME].reshape(frames, FRAME)), axis=1))


def best_envelope_correlation(signal, reference, max_lag_frames=50):
    """Pearson correlation of 20 ms RMS envelopes at the best lag in [0, 1 s]. Robust to the
    phase changes and reverberation of the acoustic path, unlike waveform correlation."""
    s, r = envelope(signal), envelope(reference)
    best, best_lag = -1.0, 0
    for lag in range(max_lag_frames + 1):
        n = min(len(s) - lag, len(r))
        if n < 50:
            break
        c = np.corrcoef(s[lag: lag + n], r[:n])[0, 1]
        if c > best:
            best, best_lag = c, lag
    return best, best_lag * FRAME / SAMPLE_RATE


def peak_waveform_correlation(signal, reference):
    n = len(signal) + len(reference)
    xc = np.fft.irfft(np.fft.rfft(signal, n) * np.conj(np.fft.rfft(reference, n)), n)[: len(signal)]
    return float(np.max(np.abs(xc)) / (np.linalg.norm(reference) * np.linalg.norm(signal) + 1e-9))


def db(ratio):
    return 20 * np.log10(max(ratio, 1e-9))


def capture_mic(helper, speech, duration, voice_processing, play, out_dir):
    start = {"cmd": "start", "mic": {"enabled": True, "device_uid": None, "voice_processing": voice_processing},
             "system": {"enabled": True}}
    tag = f"vp-{'on' if voice_processing else 'off'}-{'play' if play else 'control'}"
    actions = [(PLAY_AT, lambda: play_detached(speech))] if play else []
    capture, code, _ = run_capture(helper, start, duration, actions=actions,
                                   stderr_path=os.path.join(out_dir, f"helper-{tag}.stderr"))
    assert code == 0, f"helper exited {code}"
    started = next(e for _, e in capture.events if e["event"] == "started")
    assert started["mic"]["voice_processing"] == voice_processing, started
    mic, _ = assemble(capture.chunks, "mic")
    system, _ = assemble(capture.chunks, "system")
    write_wav(os.path.join(out_dir, f"mic-{tag}.wav"), mic)
    write_wav(os.path.join(out_dir, f"system-{tag}.wav"), system)
    return mic.astype(np.float64), system.astype(np.float64)


def measure(helper, speech, reference, voice_processing, out_dir):
    length = len(reference) / SAMPLE_RATE
    duration = PLAY_AT + length + 1.5
    mic, system = capture_mic(helper, speech, duration, voice_processing, True, out_dir)
    control, _ = capture_mic(helper, speech, duration, voice_processing, False, out_dir)

    # afplay starts ~0.1-0.3 s after it is launched.
    window = slice(int((PLAY_AT + 0.3) * SAMPLE_RATE), int((PLAY_AT + length) * SAMPLE_RATE))
    search = mic[int(PLAY_AT * SAMPLE_RATE): int((PLAY_AT + length + 1) * SAMPLE_RATE)]
    env_corr, env_lag = best_envelope_correlation(search, reference)
    control_search = control[int(PLAY_AT * SAMPLE_RATE): int((PLAY_AT + length + 1) * SAMPLE_RATE)]
    return {
        "mic_rms_playback": rms(mic[window]),
        "mic_rms_control": rms(control[window]),
        "echo_vs_control_db": db(rms(mic[window]) / max(rms(control[window]), 1e-9)),
        "envelope_corr": env_corr,
        "envelope_lag_s": env_lag,
        "control_envelope_corr": best_envelope_correlation(control_search, reference)[0],
        "waveform_corr": peak_waveform_correlation(search, reference),
        "system_rms_playback": rms(system[window]),
    }


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", default=os.path.join(here, "..", "dist", "granola-helper"))
    parser.add_argument("--volume", type=int, help="temporarily unmute and set output volume (0-100)")
    parser.add_argument("--out", default=tempfile.mkdtemp(prefix="granola-echo-"))
    args = parser.parse_args()

    speech = os.path.join(args.out, "speech.aiff")
    reference_wav = os.path.join(args.out, "reference.wav")
    subprocess.run(["say", "-o", speech, SPEECH], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", speech, reference_wav], check=True)
    reference = read_wav(reference_wav)

    original = volume_settings()
    print(f"output volume {original[0]}, muted {original[1]}")
    if args.volume is not None:
        set_volume(args.volume, False)
    elif original[1] or original[0] == 0:
        print("output is muted: the speakers cannot reach the mic; rerun with --volume N")
        return 1
    try:
        results = [measure(args.helper, speech, reference, vp, args.out) for vp in (False, True)]
    finally:
        if args.volume is not None:
            set_volume(*original)

    print(f"{'voice processing':<28}{'off':>12}{'on':>12}")
    rows = [
        ("mic RMS, playback", "mic_rms_playback", "{:.1f}"),
        ("mic RMS, control (silence)", "mic_rms_control", "{:.1f}"),
        ("echo vs control (dB)", "echo_vs_control_db", "{:+.1f}"),
        ("envelope corr w/ reference", "envelope_corr", "{:.3f}"),
        ("  same, control run", "control_envelope_corr", "{:.3f}"),
        ("envelope lag (s)", "envelope_lag_s", "{:.2f}"),
        ("peak waveform corr", "waveform_corr", "{:.3f}"),
        ("system RMS, playback", "system_rms_playback", "{:.1f}"),
    ]
    for label, key, fmt in rows:
        print(f"{label:<28}" + "".join(f"{fmt.format(r[key]):>12}" for r in results))
    off, on = results
    print(f"echo above control: {off['echo_vs_control_db']:+.1f} dB without voice processing, "
          f"{on['echo_vs_control_db']:+.1f} dB with it; recordings in {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

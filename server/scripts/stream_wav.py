"""Stream a WAV file to /v1/listen the way the app does and report what comes back.

    python scripts/stream_wav.py ws://<host>:8765/v1/listen talk.wav --reference talk.txt
    python scripts/stream_wav.py $URL talk.wav --speed 4      # 4x real time
    python scripts/stream_wav.py $URL talk.wav --speed 0      # as fast as the socket allows

Lag of a message = arrival time - time the audio at its end_ms was sent. For finals this
includes the server's end-of-utterance wait (min_silence - post_pad = 400 ms by default).
The token comes from --token or $GRANOLA_ASR_TOKEN.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

import jiwer
import numpy as np
import soundfile as sf
import soxr
import websockets
from whisper_normalizer.english import EnglishTextNormalizer

SR = 16_000


@dataclass
class Report:
    sent_at: list[float] = field(default_factory=list)  # monotonic send time of each chunk
    chunk_samples: int = 0
    finals: list[dict] = field(default_factory=list)
    interim_lags_ms: list[float] = field(default_factory=list)
    final_lags_ms: list[float] = field(default_factory=list)

    def lag_ms(self, end_ms: int, now: float) -> float | None:
        chunk = (end_ms * SR // 1000 - 1) // self.chunk_samples
        if 0 <= chunk < len(self.sent_at):
            return 1000 * (now - self.sent_at[chunk])
        return None


def load_audio(path: Path) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    return soxr.resample(mono, sr, SR) if sr != SR else mono


async def send(ws: websockets.ClientConnection, audio: np.ndarray, report: Report, speed: float) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    t0 = time.monotonic()
    for i in range(0, len(pcm), report.chunk_samples):
        if speed > 0:
            await asyncio.sleep(max(0.0, t0 + i / SR / speed - time.monotonic()))
        report.sent_at.append(time.monotonic())
        await ws.send(pcm[i : i + report.chunk_samples].tobytes())
    await ws.send(json.dumps({"type": "end"}))


async def receive(ws: websockets.ClientConnection, report: Report, t0: float) -> None:
    async for raw in ws:
        msg = json.loads(raw)
        now = time.monotonic()
        kind = msg["type"]
        if kind == "closed":
            return
        if kind not in ("interim", "final"):
            print(f"[{now - t0:7.2f}s] {msg}")
            continue
        lag = report.lag_ms(msg["end_ms"], now)
        if lag is not None:
            (report.final_lags_ms if kind == "final" else report.interim_lags_ms).append(lag)
        if kind == "final":
            report.finals.append(msg)
        lag_s = f"{lag:5.0f}" if lag is not None else "    ?"
        span = f"{msg['start_ms'] / 1000:7.2f}-{msg['end_ms'] / 1000:7.2f}"
        print(f"[{now - t0:7.2f}s] {kind:7s} {msg['segment_id']:>12s} {span} lag {lag_s} ms | {msg['text']}")


def word_error_rate(reference: str, hypothesis: str) -> float:
    """WER after the Whisper English normaliser, as in eval/eval_asr.py."""
    normalize = EnglishTextNormalizer()
    return 100 * jiwer.wer(normalize(reference), normalize(hypothesis))


def summarize(name: str, values: list[float]) -> str:
    if not values:
        return f"{name}: none"
    v = sorted(values)
    p90 = v[int(0.9 * (len(v) - 1))]
    return f"{name}: n={len(v)} p50={statistics.median(v):.0f} ms p90={p90:.0f} ms max={v[-1]:.0f} ms"


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("wav", type=Path)
    parser.add_argument("--token", default=os.environ.get("GRANOLA_ASR_TOKEN"))
    parser.add_argument("--speed", type=float, default=1.0, help="1 = real time, 0 = unthrottled")
    parser.add_argument("--chunk-ms", type=int, default=40)
    parser.add_argument("--offset-ms", type=int, default=0)
    parser.add_argument("--no-interims", action="store_true")
    parser.add_argument("--reference", type=Path, help="text file with the reference transcript")
    args = parser.parse_args()
    if not args.token:
        parser.error("pass --token or set GRANOLA_ASR_TOKEN")

    audio = load_audio(args.wav)
    report = Report(chunk_samples=SR * args.chunk_ms // 1000)
    headers = {"Authorization": f"Bearer {args.token}"}
    async with websockets.connect(args.url, additional_headers=headers, max_size=None) as ws:
        start = {
            "type": "start",
            "sample_rate": SR,
            "encoding": "pcm_s16le",
            "language": "en",
            "offset_ms": args.offset_ms,
            "interim_results": not args.no_interims,
        }
        await ws.send(json.dumps(start))
        print(json.loads(await ws.recv()))
        t0 = time.monotonic()
        await asyncio.gather(send(ws, audio, report, args.speed), receive(ws, report, t0))
        wall = time.monotonic() - t0

    transcript = " ".join(f["text"] for f in report.finals)
    print("\n--- transcript ---\n" + transcript + "\n")
    print(f"audio {len(audio) / SR:.1f} s streamed in {wall:.1f} s; {len(report.finals)} finals")
    print(summarize("interim lag", report.interim_lags_ms))
    print(summarize("final lag  ", report.final_lags_ms))
    if args.reference:
        print(f"WER vs reference: {word_error_rate(args.reference.read_text(), transcript):.2f}%")


if __name__ == "__main__":
    asyncio.run(main())

"""Parser for granola-helper's stdout protocol, shared by the integration scripts."""

import json
import struct
from dataclasses import dataclass, field

SAMPLE_RATE = 16_000
SOURCES = {0: "mic", 1: "system"}


@dataclass
class AudioChunk:
    source: str
    sample_index: int
    pcm: bytes
    received_at: float  # wall-clock seconds when the reader saw it

    @property
    def samples(self) -> int:
        return len(self.pcm) // 2


@dataclass
class Capture:
    events: list = field(default_factory=list)  # (received_at, dict)
    chunks: list = field(default_factory=list)  # AudioChunk
    frame_order: list = field(default_factory=list)  # "event:<name>" / "audio:<source>"


class ProtocolError(Exception):
    pass


class FrameParser:
    """Incremental parser; feed() raw stdout bytes as they arrive."""

    def __init__(self, capture: Capture):
        self.capture = capture
        self.buffer = bytearray()

    def feed(self, data: bytes, now: float) -> None:
        self.buffer += data
        while len(self.buffer) >= 5:
            kind, length = struct.unpack_from("<BI", self.buffer, 0)
            if len(self.buffer) < 5 + length:
                return
            payload = bytes(self.buffer[5 : 5 + length])
            del self.buffer[: 5 + length]
            if kind == 0x01:
                if length < 9 or (length - 9) % 2:
                    raise ProtocolError(f"bad audio frame length {length}")
                source, index = struct.unpack_from("<BQ", payload, 0)
                if source not in SOURCES:
                    raise ProtocolError(f"unknown source {source}")
                self.capture.chunks.append(AudioChunk(SOURCES[source], index, payload[9:], now))
                self.capture.frame_order.append("audio:" + SOURCES[source])
            elif kind == 0x02:
                event = json.loads(payload.decode("utf-8"))
                if not isinstance(event, dict) or "event" not in event:
                    raise ProtocolError(f"bad event {event!r}")
                self.capture.events.append((now, event))
                self.capture.frame_order.append("event:" + event["event"])
            else:
                raise ProtocolError(f"unknown frame type {kind}")

    def finish(self) -> None:
        if self.buffer:
            raise ProtocolError(f"{len(self.buffer)} trailing bytes")


def assemble(chunks, source: str):
    """Lays one source's chunks on the shared timeline the way a consumer must: zero-fill
    forward jumps, trim overlaps. Returns (int16 numpy array, stats)."""
    import numpy as np

    out = []
    end = None
    gaps = overlaps = 0
    gap_samples = overlap_samples = 0
    for chunk in (c for c in chunks if c.source == source):
        pcm = np.frombuffer(chunk.pcm, dtype="<i2")
        start = chunk.sample_index
        if end is None:
            out.append(np.zeros(start, dtype=np.int16))
        elif start > end:
            gaps += 1
            gap_samples += start - end
            out.append(np.zeros(start - end, dtype=np.int16))
        elif start < end:
            overlaps += 1
            overlap_samples += end - start
            pcm = pcm[end - start :]
        out.append(pcm)
        end = max(end or 0, start + len(np.frombuffer(chunk.pcm, dtype="<i2")))
    signal = np.concatenate(out) if out else np.zeros(0, dtype=np.int16)
    return signal, {"gaps": gaps, "gap_samples": gap_samples, "overlaps": overlaps, "overlap_samples": overlap_samples}


def write_wav(path: str, samples) -> None:
    import wave

    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.astype("<i2").tobytes())


def run_capture(helper: str, start: dict, duration: float, actions=(), stderr_path=None):
    """Runs `helper capture`, sends `start`, reads frames for `duration` seconds while calling
    each `(at_seconds, callable)` in `actions`, then closes stdin and waits for exit.
    Returns (Capture, exit_code, t_start) where t_start is the wall time `start` was sent."""
    import os
    import select
    import subprocess
    import time

    stderr = open(stderr_path, "wb") if stderr_path else subprocess.DEVNULL
    process = subprocess.Popen([helper, "capture"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr)
    capture = Capture()
    parser = FrameParser(capture)
    os.set_blocking(process.stdout.fileno(), False)
    pending = sorted(actions, key=lambda a: a[0])

    t_start = time.time()
    process.stdin.write((json.dumps(start) + "\n").encode())
    process.stdin.flush()
    while time.time() - t_start < duration:
        ready, _, _ = select.select([process.stdout], [], [], 0.02)
        if ready:
            data = process.stdout.read(1 << 16)
            if data:
                parser.feed(data, time.time())
        while pending and time.time() - t_start >= pending[0][0]:
            pending.pop(0)[1]()

    process.stdin.close()  # EOF: the helper must stop, write `stopped` and exit 0
    os.set_blocking(process.stdout.fileno(), True)
    parser.feed(process.stdout.read(), time.time())
    parser.finish()
    code = process.wait(timeout=10)
    if stderr_path:
        stderr.close()
    return capture, code, t_start


def play_detached(path: str):
    """Plays `path` with afplay from a grandchild process. The helper excludes its parent's
    other children from the system tap (that is how it excludes the app's own audio), so an
    afplay started directly by this script would be muted in the capture."""
    import subprocess

    return subprocess.Popen(["/bin/sh", "-c", 'afplay "$0"; exit $?', path])

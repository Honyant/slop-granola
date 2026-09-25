"""Deterministic stand-ins for the VAD and the recognizers, plus synthetic audio."""

from __future__ import annotations

import threading
from collections.abc import Callable

import numpy as np

SR = 16_000


def tone(seconds: float, amplitude: float = 0.3, hz: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def to_pcm(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def energy_detector(frame: np.ndarray) -> float:
    """Speech probability 1 for anything louder than -30 dBFS RMS, else 0."""
    return 1.0 if float(np.sqrt(np.mean(frame**2))) > 0.03 else 0.0


class FakeRecognizer:
    """Returns `render(audio)`; optionally blocks until released, to script worker interleavings."""

    def __init__(self, name: str, render: Callable[[np.ndarray], str] | None = None, gated: bool = False) -> None:
        self.name = name
        self._render = render or (lambda audio: f"{name} {len(audio) * 1000 // SR} ms.")
        self.calls: list[int] = []  # audio length of each call, in order
        self.started = threading.Semaphore(0)
        self._gate = threading.Semaphore(0) if gated else None

    def release(self, n: int = 1) -> None:
        assert self._gate is not None
        for _ in range(n):
            self._gate.release()

    def transcribe(self, audio: np.ndarray) -> str:
        self.calls.append(len(audio))
        self.started.release()
        if self._gate is not None:
            assert self._gate.acquire(timeout=5), "test never released the recognizer"
        return self._render(audio)

"""Loading recognizers by model id, and the fallback wrapper.

Backends are imported lazily so a machine only needs the one it uses: PyTorch + CUDA
(models_torch.py) on a GPU host, MLX (models_mlx.py) on Apple Silicon.
"""

from __future__ import annotations

import contextlib
import logging
import time
from collections.abc import Callable

import numpy as np

from .engine import Recognizer

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000


class DegenerateOutput(Exception):
    """The model hit its output budget, i.e. it was looping rather than transcribing."""


class WithFallback:
    """Use `fallback` for the segments on which `primary` degenerates."""

    def __init__(self, primary: Recognizer, fallback: Recognizer) -> None:
        self.name = primary.name
        self._primary = primary
        self._fallback = fallback

    def transcribe(self, audio: np.ndarray) -> str:
        try:
            return self._primary.transcribe(audio)
        except DegenerateOutput as exc:
            log.warning("%s degenerated (%s); using %s", self._primary.name, exc, self._fallback.name)
            return self._fallback.transcribe(audio)


def _factory(model_id: str) -> Callable[[str, str], Recognizer]:
    if model_id.startswith("mlx-community/"):
        from .models_mlx import MlxParakeet

        return MlxParakeet
    from .models_torch import FACTORIES

    if model_id not in FACTORIES:
        raise SystemExit(f"unsupported model {model_id!r}; supported: {sorted(FACTORIES)} or mlx-community/parakeet-*")
    return FACTORIES[model_id]


def load_recognizer(model_id: str, device: str) -> Recognizer:
    t0 = time.perf_counter()
    recognizer = _factory(model_id)(model_id, device)
    # Warm up at a few lengths so CUDA kernels, autotuning and compilation happen now,
    # not on the first user's first utterance.
    rng = np.random.default_rng(0)
    for seconds in (1, 4, 12):
        with contextlib.suppress(DegenerateOutput):  # noise may well make a model babble
            recognizer.transcribe((0.01 * rng.standard_normal(seconds * SAMPLE_RATE)).astype(np.float32))
    log.info("loaded %s in %.1f s", model_id, time.perf_counter() - t0)
    return recognizer

"""Parakeet on Apple Silicon through MLX, for running the server on a Mac.

Same model family as the GPU host's interim model (Parakeet-TDT 0.6B v3): cased and
punctuated, and silent on silence and noise. On an M1 Pro it transcribes a 10 s segment
in well under a second, fast enough to serve both interims and finals.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import mlx.core as mx
import numpy as np
from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel


class MlxParakeet:
    """MLX streams are thread-local, and the model is loaded (and warmed up) on a different
    thread from the server's inference worker, so every MLX call runs on one owned thread."""

    def __init__(self, model_id: str, device: str) -> None:
        del device  # MLX always runs on the Apple GPU
        self.name = model_id
        self._thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
        self._model = self._thread.submit(from_pretrained, model_id).result()

    def transcribe(self, audio: np.ndarray) -> str:
        return self._thread.submit(self._transcribe, audio).result()

    def _transcribe(self, audio: np.ndarray) -> str:
        # float32, not bfloat16: get_logmel reinterprets the complex STFT as the input dtype,
        # which only lines up for float32 (parakeet_mlx's own load_audio always yields float32).
        mel = get_logmel(mx.array(audio, dtype=mx.float32), self._model.preprocessor_config)
        return self._model.generate(mel)[0].text.strip()

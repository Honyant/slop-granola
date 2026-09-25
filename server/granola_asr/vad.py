"""Silero VAD v6 via ONNX Runtime on CPU.

One ONNX session is shared by all streams; each stream owns only its recurrent state
and the 64-sample context the model expects in front of every 512-sample frame.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .segmenter import FRAME_SAMPLES

_CONTEXT_SAMPLES = 64
_SAMPLE_RATE = np.array(16_000, dtype=np.int64)


class SileroVad:
    def __init__(self) -> None:
        opts = ort.SessionOptions()
        # The model is tiny; thread fan-out costs more than it saves and would contend with the GPU worker.
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        # Locate the model file without importing the silero_vad package: its import runs
        # torch.set_num_threads(1), which invalidates every graph torch.compile built so far and
        # made the first final after startup take 9.4 s instead of 0.4 s.
        spec = importlib.util.find_spec("silero_vad")
        assert spec is not None and spec.submodule_search_locations
        path = str(Path(spec.submodule_search_locations[0]) / "data" / "silero_vad.onnx")
        self._session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])

    def detector(self) -> SileroDetector:
        return SileroDetector(self._session)


class SileroDetector:
    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._input = np.zeros((1, _CONTEXT_SAMPLES + FRAME_SAMPLES), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        self._input[0, _CONTEXT_SAMPLES:] = frame
        prob, self._state = self._session.run(None, {"input": self._input, "state": self._state, "sr": _SAMPLE_RATE})
        self._input[0, :_CONTEXT_SAMPLES] = frame[-_CONTEXT_SAMPLES:]
        return float(prob[0, 0])

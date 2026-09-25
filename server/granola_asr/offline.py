"""POST /v1/transcribe: whole-file re-transcription with the final model."""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass

import numpy as np
import soundfile as sf
import soxr

from .engine import InferenceEngine
from .segmenter import Segmenter, SegmenterConfig, SpeechDetector, Utterance, UtteranceClosed
from .text import clean_text


class AudioDecodeError(ValueError):
    pass


@dataclass(frozen=True)
class TranscribedSegment:
    start_ms: int
    end_ms: int
    text: str


def decode_wav(data: bytes, sample_rate: int) -> np.ndarray:
    """Any-rate, any-channel-count WAV -> mono float32 at `sample_rate`."""
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError) as exc:
        raise AudioDecodeError(f"cannot decode audio: {exc}") from None
    mono = audio.mean(axis=1)
    if sr != sample_rate:
        mono = soxr.resample(mono, sr, sample_rate, quality="HQ")
    return np.ascontiguousarray(mono, dtype=np.float32)


def segment_all(audio: np.ndarray, detector: SpeechDetector, config: SegmenterConfig) -> list[Utterance]:
    segmenter = Segmenter(detector, config, interims=False)
    events = segmenter.feed(audio) + segmenter.flush()
    return [e.utterance for e in events if isinstance(e, UtteranceClosed)]


async def transcribe_file(
    data: bytes, engine: InferenceEngine, detector: SpeechDetector, config: SegmenterConfig
) -> list[TranscribedSegment]:
    # Decoding and VAD over a long file are CPU-bound for seconds; keep them off the event loop.
    audio = await asyncio.to_thread(decode_wav, data, config.sample_rate)
    utterances = await asyncio.to_thread(segment_all, audio, detector, config)
    texts = await asyncio.gather(*(asyncio.wrap_future(engine.submit_batch(u.audio)) for u in utterances))
    sr = config.sample_rate
    return [
        TranscribedSegment(u.start_sample * 1000 // sr, u.end_sample * 1000 // sr, text)
        for u, raw in zip(utterances, texts, strict=True)
        if (text := clean_text(raw))
    ]

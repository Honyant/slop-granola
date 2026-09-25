"""VAD-driven utterance segmentation over a single audio stream.

All positions are absolute sample indices since the start of the stream; nothing here
looks at a clock. The segmenter is synchronous and allocation-light so it can run
inline on the event loop (see README, "VAD on the event loop").
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

FRAME_SAMPLES = 512  # 32 ms at 16 kHz: Silero VAD's native window.

SpeechDetector = Callable[[np.ndarray], float]
"""Maps one float32 frame of FRAME_SAMPLES samples to a speech probability. Stateful per stream."""


@dataclass(frozen=True)
class SegmenterConfig:
    sample_rate: int = 16_000
    speech_threshold: float = 0.5
    silence_threshold: float = 0.35
    min_silence_ms: int = 600
    min_speech_ms: int = 250
    pre_pad_ms: int = 300
    post_pad_ms: int = 200
    max_segment_ms: int = 25_000
    split_search_ms: int = 5_000
    interim_every_ms: int = 480

    def samples(self, ms: int) -> int:
        return ms * self.sample_rate // 1000


@dataclass(frozen=True)
class Utterance:
    index: int
    start_sample: int
    end_sample: int
    audio: np.ndarray  # float32 in [-1, 1], samples [start_sample, end_sample)


@dataclass(frozen=True)
class InterimReady:
    """The open utterance has grown enough to be worth re-decoding."""

    utterance: Utterance


@dataclass(frozen=True)
class UtteranceClosed:
    utterance: Utterance


SegmenterEvent = InterimReady | UtteranceClosed


class _SampleBuffer:
    """Append-only float32 buffer addressed by absolute sample index, with cheap front trimming."""

    def __init__(self) -> None:
        self._data = np.zeros(1 << 16, dtype=np.float32)
        self._offset = 0  # index into _data of the first retained sample
        self._len = 0
        self.start = 0  # absolute index of the first retained sample

    @property
    def end(self) -> int:
        return self.start + self._len

    def append(self, samples: np.ndarray) -> None:
        needed = self._offset + self._len + len(samples)
        if needed > len(self._data):
            # Compact first; grow only if the live data genuinely does not fit.
            live = self._data[self._offset : self._offset + self._len]
            capacity = len(self._data)
            while self._len + len(samples) > capacity // 2:
                capacity *= 2
            data = np.empty(capacity, dtype=np.float32)
            data[: self._len] = live
            self._data, self._offset = data, 0
        tail = self._offset + self._len
        self._data[tail : tail + len(samples)] = samples
        self._len += len(samples)

    def slice(self, start: int, end: int) -> np.ndarray:
        assert self.start <= start <= end <= self.end, (start, end, self.start, self.end)
        a = self._offset + start - self.start
        return self._data[a : a + end - start].copy()

    def drop_before(self, position: int) -> None:
        position = min(max(position, self.start), self.end)
        dropped = position - self.start
        self._offset += dropped
        self._len -= dropped
        self.start = position


@dataclass
class _Frame:
    start: int
    energy: float
    speech: bool


@dataclass
class _OpenUtterance:
    start: int
    frames: list[_Frame]  # frames since the VAD triggered (pre-padding is not included)
    last_speech_end: int
    next_interim_at: int
    speech_since_interim: bool
    voiced: int  # samples in frames classified as speech


class Segmenter:
    """Turns PCM into utterances using a per-frame speech detector.

    Guarantees: utterance indices are consecutive from 0; utterances are emitted in
    order; utterance i ends at or before utterance i+1 starts; an InterimReady for an
    utterance always precedes its UtteranceClosed.
    """

    def __init__(self, detector: SpeechDetector, config: SegmenterConfig, interims: bool) -> None:
        self._detect = detector
        self._cfg = config
        self._interims = interims
        self._buffer = _SampleBuffer()
        self._carry = np.zeros(0, dtype=np.float32)  # < 1 frame not yet run through VAD
        self._open: _OpenUtterance | None = None
        self._prev_end = 0
        self._next_index = 0

        self._min_silence = config.samples(config.min_silence_ms)
        self._min_speech = config.samples(config.min_speech_ms)
        self._pre_pad = config.samples(config.pre_pad_ms)
        self._post_pad = config.samples(config.post_pad_ms)
        self._max_len = config.samples(config.max_segment_ms)
        self._split_search = config.samples(config.split_search_ms)
        self._interim_every = config.samples(config.interim_every_ms)
        assert self._post_pad <= self._min_silence, "post-padding must be audio we already waited for"
        assert self._split_search < self._max_len - self._pre_pad

    @property
    def position(self) -> int:
        """Absolute sample index up to which audio has been run through VAD."""
        return self._buffer.end

    def feed(self, pcm: np.ndarray) -> list[SegmenterEvent]:
        """Consume float32 samples of any length."""
        samples = np.concatenate([self._carry, pcm]) if len(self._carry) else pcm
        n_frames = len(samples) // FRAME_SAMPLES
        self._carry = samples[n_frames * FRAME_SAMPLES :].copy()
        events: list[SegmenterEvent] = []
        for i in range(n_frames):
            self._step(samples[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES], events)
        return events

    def flush(self) -> list[SegmenterEvent]:
        """Close the open utterance now (client `finalize` / `end`)."""
        events: list[SegmenterEvent] = []
        if self._open is not None:
            self._close(min(self._open.last_speech_end + self._post_pad, self.position), events)
        return events

    def _step(self, frame: np.ndarray, events: list[SegmenterEvent]) -> None:
        frame_start = self._buffer.end
        self._buffer.append(frame)
        frame_end = self._buffer.end
        prob = self._detect(frame)
        cfg = self._cfg
        is_speech = prob >= cfg.speech_threshold or (self._open is not None and prob >= cfg.silence_threshold)

        if self._open is None:
            if is_speech:
                start = max(frame_start - self._pre_pad, self._prev_end, self._buffer.start)
                self._open = _OpenUtterance(
                    start=start,
                    frames=[],
                    last_speech_end=frame_end,
                    next_interim_at=frame_start + self._interim_every,
                    speech_since_interim=True,
                    voiced=0,
                )
            else:
                self._buffer.drop_before(frame_end - self._pre_pad)
                return

        u = self._open
        u.frames.append(_Frame(frame_start, float(np.dot(frame, frame)), is_speech))
        if is_speech:
            u.last_speech_end = frame_end
            u.speech_since_interim = True
            u.voiced += FRAME_SAMPLES

        if frame_end - u.last_speech_end >= self._min_silence:
            self._close(u.last_speech_end + self._post_pad, events)
        elif frame_end - u.start >= self._max_len:
            self._split(events)
        elif (
            self._interims
            and frame_end >= u.next_interim_at
            and u.speech_since_interim
            and u.voiced >= self._min_speech
        ):
            # Clip trailing silence so an interim never extends past where the final will end.
            end = min(frame_end, u.last_speech_end + self._post_pad)
            events.append(InterimReady(self._utterance(u.start, end)))
            u.next_interim_at = frame_end + self._interim_every
            u.speech_since_interim = False

    def _close(self, end: int, events: list[SegmenterEvent]) -> None:
        u = self._open
        assert u is not None
        self._open = None
        self._emit(u.start, end, u.voiced, events)
        self._buffer.drop_before(max(end, self.position - self._pre_pad))

    def _split(self, events: list[SegmenterEvent]) -> None:
        """Cut an over-long utterance at its quietest frame in the last split_search_ms."""
        u = self._open
        assert u is not None
        window_start = self.position - self._split_search
        cut_i = min(
            (i for i, f in enumerate(u.frames) if f.start >= window_start),
            key=lambda i: u.frames[i].energy,
        )
        tail = u.frames[cut_i:]
        tail_voiced = FRAME_SAMPLES * sum(f.speech for f in tail)
        cut = tail[0].start
        self._emit(u.start, cut, u.voiced - tail_voiced, events)
        self._buffer.drop_before(cut)
        self._open = _OpenUtterance(
            start=cut,
            frames=tail,
            last_speech_end=u.last_speech_end,
            next_interim_at=self.position,
            speech_since_interim=tail_voiced > 0,
            voiced=tail_voiced,
        )

    def _emit(self, start: int, end: int, voiced: int, events: list[SegmenterEvent]) -> None:
        """Emit a closed utterance unless it is too little speech to be worth a final (a blip)."""
        if voiced >= self._min_speech:
            events.append(UtteranceClosed(self._utterance(start, end)))
            self._next_index += 1
            self._prev_end = end

    def _utterance(self, start: int, end: int) -> Utterance:
        return Utterance(self._next_index, start, end, self._buffer.slice(start, end))

from __future__ import annotations

import itertools

import numpy as np
import pytest

from granola_asr.segmenter import (
    FRAME_SAMPLES,
    InterimReady,
    Segmenter,
    SegmenterConfig,
    SegmenterEvent,
    Utterance,
    UtteranceClosed,
)
from tests.fakes import SR, energy_detector, silence, tone

CFG = SegmenterConfig()


def run(
    audio: np.ndarray, *, chunk: int | None = None, interims: bool = True, flush: bool = True
) -> list[SegmenterEvent]:
    seg = Segmenter(energy_detector, CFG, interims=interims)
    step = chunk or len(audio)
    events = [e for i in range(0, len(audio), step) for e in seg.feed(audio[i : i + step])]
    return events + (seg.flush() if flush else [])


def closed(events: list[SegmenterEvent]) -> list[Utterance]:
    return [e.utterance for e in events if isinstance(e, UtteranceClosed)]


def ms(sample: int) -> float:
    return sample * 1000 / SR


def test_single_utterance_is_padded_on_both_sides() -> None:
    [u] = closed(run(np.concatenate([silence(1), tone(2), silence(2)]), flush=False))
    # Speech is at [1000, 3000) ms; the VAD works on 32 ms frames, so allow one frame of slop.
    assert ms(u.start_sample) == pytest.approx(1000 - CFG.pre_pad_ms, abs=32)
    assert ms(u.end_sample) == pytest.approx(3000 + CFG.post_pad_ms, abs=32)
    assert u.index == 0


def test_closes_only_after_min_silence() -> None:
    audio = np.concatenate([tone(1), silence(0.5), tone(1), silence(2)])
    assert len(closed(run(audio, flush=False))) == 1  # a 500 ms pause does not end the utterance

    audio = np.concatenate([tone(1), silence(0.7), tone(1), silence(2)])
    assert len(closed(run(audio, flush=False))) == 2


def test_utterances_never_overlap_even_when_padding_would() -> None:
    # A 640 ms gap is shorter than post_pad + pre_pad, so the pre-pad must be clamped.
    audio = np.concatenate([tone(1), silence(0.64), tone(1), silence(0.64), tone(1), silence(2)])
    us = closed(run(audio, flush=False))
    assert [u.index for u in us] == [0, 1, 2]
    for a, b in itertools.pairwise(us):
        assert a.end_sample <= b.start_sample


def test_blips_shorter_than_min_speech_are_dropped() -> None:
    assert closed(run(np.concatenate([silence(1), tone(0.15), silence(2)]))) == []


def test_audio_matches_input_span() -> None:
    audio = np.concatenate([silence(1), tone(2), silence(2)])
    [u] = closed(run(audio))
    assert len(u.audio) == u.end_sample - u.start_sample
    np.testing.assert_array_equal(u.audio, audio[u.start_sample : u.end_sample])


def test_chunking_does_not_change_the_result() -> None:
    audio = np.concatenate([silence(0.3), tone(1.3), silence(0.9), tone(2.2), silence(0.8), tone(0.4)])
    whole = closed(run(audio))
    for chunk in (1, 320, 511, 513, 1600):
        pieces = closed(run(audio, chunk=chunk))
        assert [(u.start_sample, u.end_sample) for u in pieces] == [(u.start_sample, u.end_sample) for u in whole]


def test_interims_are_periodic_and_precede_their_final() -> None:
    events = run(np.concatenate([silence(0.5), tone(3), silence(1)]), flush=False)
    interims = [e for e in events if isinstance(e, InterimReady)]
    assert isinstance(events[-1], UtteranceClosed)
    assert all(isinstance(e, InterimReady) for e in events[:-1])
    # ~3 s of speech at one interim per 480 ms.
    assert 5 <= len(interims) <= 7
    ends = [e.utterance.end_sample for e in interims]
    gaps_ms = [ms(b - a) for a, b in itertools.pairwise(ends)]
    # Periodic while speech continues; the last one may be clipped to the end of speech.
    assert all(CFG.interim_every_ms <= g < CFG.interim_every_ms + 32 for g in gaps_ms[:-1])
    assert 0 < gaps_ms[-1] < CFG.interim_every_ms + 32
    assert ends[-1] <= events[-1].utterance.end_sample
    assert {e.utterance.index for e in events} == {0}


def test_no_interims_during_trailing_silence() -> None:
    events = run(np.concatenate([tone(1), silence(0.59)]), flush=False)
    last_interim_end = max(e.utterance.end_sample for e in events if isinstance(e, InterimReady))
    assert ms(last_interim_end) <= 1000 + CFG.interim_every_ms + 32


def test_interims_can_be_disabled() -> None:
    events = run(np.concatenate([tone(3), silence(1)]), interims=False)
    assert all(isinstance(e, UtteranceClosed) for e in events) and len(events) == 1


def test_flush_closes_the_open_utterance() -> None:
    seg = Segmenter(energy_detector, CFG, interims=False)
    assert seg.feed(tone(2)) == []
    [event] = seg.flush()
    assert isinstance(event, UtteranceClosed)
    assert event.utterance.end_sample == seg.position
    assert seg.flush() == []


def test_long_speech_is_split_at_the_quietest_point() -> None:
    # 40 s of loud speech with a quieter (but still voiced) dip at 22.0-22.1 s.
    audio = tone(40)
    dip = slice(int(22.0 * SR), int(22.1 * SR))
    audio[dip] *= 0.2
    us = closed(run(audio))
    assert len(us) == 2
    first, second = us
    assert ms(first.end_sample - first.start_sample) <= CFG.max_segment_ms
    assert 22_000 <= ms(first.end_sample) <= 22_100 - 32
    assert first.end_sample == second.start_sample  # contiguous: nothing lost, nothing duplicated


def test_split_without_a_quiet_point_still_respects_max_length() -> None:
    us = closed(run(tone(70)))
    assert all(ms(u.end_sample - u.start_sample) <= CFG.max_segment_ms for u in us)
    assert all(a.end_sample == b.start_sample for a, b in itertools.pairwise(us))
    assert us[-1].end_sample == 70 * SR // FRAME_SAMPLES * FRAME_SAMPLES

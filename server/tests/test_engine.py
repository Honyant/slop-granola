from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pytest

from granola_asr.engine import InferenceEngine
from tests.fakes import FakeRecognizer


def audio(n: int) -> np.ndarray:
    return np.zeros(n, dtype=np.float32)


@pytest.fixture
def gated() -> Iterator[tuple[InferenceEngine, FakeRecognizer, FakeRecognizer]]:
    interim, final = FakeRecognizer("interim", gated=True), FakeRecognizer("final", gated=True)
    engine = InferenceEngine(interim, final)
    engine.start()
    yield engine, interim, final
    engine.stop()


def test_finals_run_before_interims_and_batch_runs_last(gated) -> None:
    engine, interim, final = gated
    blocker = engine.submit_final("a", audio(1))
    assert final.started.acquire(timeout=5)  # worker is now busy; everything below queues up

    batch = engine.submit_batch(audio(2))
    i_a = engine.submit_interim("a", audio(3))
    f_b = engine.submit_final("b", audio(4))
    i_b = engine.submit_interim("b", audio(5))
    f_c = engine.submit_final("c", audio(6))
    interim.release(2)
    final.release(4)
    for fut in (blocker, batch, i_a, f_b, i_b, f_c):
        fut.result(timeout=5)

    assert final.calls == [1, 4, 6, 2]  # live finals FIFO, then batch after everything live
    assert interim.calls == [3, 5]


def test_interims_coalesce_per_owner_latest_wins(gated) -> None:
    engine, interim, final = gated
    blocker = engine.submit_final("x", audio(1))
    assert final.started.acquire(timeout=5)

    first = engine.submit_interim("a", audio(10))
    other = engine.submit_interim("b", audio(20))
    second = engine.submit_interim("a", audio(11))
    assert first.cancelled()
    final.release()
    interim.release(2)
    assert blocker.result(timeout=5) and other.result(timeout=5) and second.result(timeout=5)
    # "a" keeps its original queue slot, so it still runs before "b".
    assert interim.calls == [11, 20]


def test_cancel_owner_drops_only_that_owners_pending_work(gated) -> None:
    engine, interim, final = gated
    blocker = engine.submit_final("x", audio(1))
    assert final.started.acquire(timeout=5)

    gone_final = engine.submit_final("gone", audio(2))
    gone_interim = engine.submit_interim("gone", audio(3))
    kept = engine.submit_final("kept", audio(4))
    engine.cancel_owner("gone")
    final.release(2)
    assert blocker.result(timeout=5) and kept.result(timeout=5)
    assert gone_final.cancelled() and gone_interim.cancelled()
    assert final.calls == [1, 4] and interim.calls == []


def test_recognizer_exceptions_reach_the_future_and_the_worker_survives() -> None:
    def boom(_: np.ndarray) -> str:
        raise RuntimeError("CUDA fell over")

    engine = InferenceEngine(FakeRecognizer("interim"), FakeRecognizer("final", render=boom))
    engine.start()
    try:
        with pytest.raises(RuntimeError, match="CUDA fell over"):
            engine.submit_final("a", audio(1)).result(timeout=5)
        assert engine.submit_interim("a", audio(1)).result(timeout=5) == "interim 0 ms."
    finally:
        engine.stop()

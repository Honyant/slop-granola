"""Single GPU worker thread with strict priorities: live finals > interims > batch.

Interims are coalesced per owner (one pending job per live session; a newer request
replaces the older one, whose future is cancelled). Finals and batch jobs are FIFO and
never dropped. Callers get `concurrent.futures.Future`s; asyncio code wraps them with
`asyncio.wrap_future`.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np

log = logging.getLogger(__name__)

SLOW_JOB_S = 1.0  # interim/batch jobs slower than this are logged; finals always are


class Recognizer(Protocol):
    name: str

    def transcribe(self, audio: np.ndarray) -> str:
        """16 kHz mono float32 in [-1, 1] -> text with casing and punctuation."""
        ...


@dataclass(frozen=True)
class _Job:
    kind: Literal["final", "interim", "batch"]
    owner: str | None
    audio: np.ndarray
    recognizer: Recognizer
    future: Future[str]
    submitted: float = field(default_factory=time.monotonic)


class InferenceEngine:
    def __init__(self, interim: Recognizer, final: Recognizer) -> None:
        self.interim_model = interim
        self.final_model = final
        self._cv = threading.Condition()
        self._finals: deque[_Job] = deque()
        self._interims: OrderedDict[str, _Job] = OrderedDict()
        self._batch: deque[_Job] = deque()
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="gpu-worker", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        with self._cv:
            self._stopping = True
            pending = [*self._finals, *self._interims.values(), *self._batch]
            self._finals.clear()
            self._interims.clear()
            self._batch.clear()
            self._cv.notify()
        for job in pending:
            job.future.cancel()
        self._thread.join()

    def submit_final(self, owner: str, audio: np.ndarray) -> Future[str]:
        job = _Job("final", owner, audio, self.final_model, Future())
        with self._cv:
            self._finals.append(job)
            self._cv.notify()
        return job.future

    def submit_interim(self, owner: str, audio: np.ndarray) -> Future[str]:
        job = _Job("interim", owner, audio, self.interim_model, Future())
        with self._cv:
            replaced = self._interims.get(owner)
            # Assigning to an existing key keeps its queue position, so a session that
            # re-requests every 480 ms cannot starve one that asked earlier.
            self._interims[owner] = job
            self._cv.notify()
        if replaced is not None:
            replaced.future.cancel()
        return job.future

    def submit_batch(self, audio: np.ndarray) -> Future[str]:
        job = _Job("batch", None, audio, self.final_model, Future())
        with self._cv:
            self._batch.append(job)
            self._cv.notify()
        return job.future

    def cancel_interim(self, owner: str) -> None:
        with self._cv:
            job = self._interims.pop(owner, None)
        if job is not None:
            job.future.cancel()

    def cancel_owner(self, owner: str) -> None:
        """Drop everything queued for a session that went away."""
        with self._cv:
            dropped = [j for j in self._finals if j.owner == owner]
            self._finals = deque(j for j in self._finals if j.owner != owner)
            interim = self._interims.pop(owner, None)
        for job in [*dropped, *([interim] if interim else [])]:
            job.future.cancel()

    def _next_job(self) -> _Job | None:
        with self._cv:
            while not (self._stopping or self._finals or self._interims or self._batch):
                self._cv.wait()
            if self._stopping:
                return None
            if self._finals:
                return self._finals.popleft()
            if self._interims:
                return self._interims.popitem(last=False)[1]
            return self._batch.popleft()

    def _run(self) -> None:
        while (job := self._next_job()) is not None:
            if not job.future.set_running_or_notify_cancel():
                continue
            started = time.monotonic()
            try:
                text = job.recognizer.transcribe(job.audio)
            except Exception as exc:  # surfaced to the session as error{code: internal}
                log.exception("%s job failed on %.2f s of audio", job.kind, len(job.audio) / 16_000)
                job.future.set_exception(exc)
                continue
            done = time.monotonic()
            job.future.set_result(text)
            if job.kind == "final" or done - started > SLOW_JOB_S:
                log.info(
                    "%s %s: %.1f s audio, queued %.0f ms, ran %.0f ms, %d chars",
                    job.kind,
                    job.owner,
                    len(job.audio) / 16_000,
                    1000 * (started - job.submitted),
                    1000 * (done - started),
                    len(text),
                )

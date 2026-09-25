"""One /v1/listen connection: PCM in, ordered interim/final messages out.

Two tasks per connection:
- the reader runs VAD inline and submits recognition jobs, never awaiting inference;
- the emitter owns the socket's send side and drains an ordered outbox. Finals enter the
  outbox as pending futures at the moment their segment closes, so the wire order is
  the segment order regardless of when inference finishes.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketDisconnected

from . import protocol
from .engine import InferenceEngine
from .protocol import Control, ErrorCode, ProtocolError, Start
from .segmenter import InterimReady, Segmenter, SegmenterConfig, SegmenterEvent, SpeechDetector, Utterance
from .text import clean_text

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PendingFinal:
    segment_id: str
    start_ms: int
    end_ms: int
    text: asyncio.Future[str]
    retracts_interim: bool  # an interim was shown for this segment, so a final must follow even if empty


# Clients send a keepalive every 10 s when idle. Enforcing it here frees the session slot of a
# client that vanished (laptop lid closed) without relying on TCP or WebSocket-ping timeouts.
IDLE_TIMEOUT_S = 30.0

_END = None  # outbox sentinel: reader saw {"type": "end"}
_Outgoing = dict[str, Any] | _PendingFinal | None


async def send_fatal(ws: WebSocket, code: ErrorCode, message: str, close_code: int) -> None:
    try:
        await ws.send_json(protocol.error(code, message, fatal=True))
        await ws.close(close_code)
    except (WebSocketDisconnect, RuntimeError):
        pass  # already gone; nothing left to tell the client


class StreamSession:
    def __init__(
        self,
        ws: WebSocket,
        session_id: str,
        start: Start,
        engine: InferenceEngine,
        detector: SpeechDetector,
        segmenter_config: SegmenterConfig,
    ) -> None:
        self.id = session_id
        self._ws = ws
        self._start = start
        self._engine = engine
        self._segmenter = Segmenter(detector, segmenter_config, interims=start.interim_results)
        self._sample_rate = segmenter_config.sample_rate
        self._outbox: asyncio.Queue[_Outgoing] = asyncio.Queue()
        self._odd_byte = b""
        self._n_closed = 0  # utterances with index < _n_closed have had their final queued
        self._interim_shown_for: int | None = None  # index of the open utterance, once an interim went out

    async def run(self) -> None:
        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(self._read())
                tg.create_task(self._emit())
        except* (WebSocketDisconnect, WebSocketDisconnected):
            log.info("session %s: client disconnected", self.id)
        except* ProtocolError as group:
            await send_fatal(self._ws, ErrorCode.BAD_REQUEST, str(group.exceptions[0]), close_code=1008)
        except* Exception:
            log.exception("session %s: internal error", self.id)
            await send_fatal(self._ws, ErrorCode.INTERNAL, "internal server error", close_code=1011)
        finally:
            self._engine.cancel_owner(self.id)

    # --- reader ---

    async def _read(self) -> None:
        while True:
            try:
                msg = await asyncio.wait_for(self._ws.receive(), IDLE_TIMEOUT_S)
            except TimeoutError:
                raise ProtocolError(f"nothing received for {IDLE_TIMEOUT_S:g} s (send keepalives)") from None
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))
            if (data := msg.get("bytes")) is not None:
                self._handle(self._segmenter.feed(self._decode_pcm(data)))
                continue
            match protocol.parse_control(msg.get("text") or ""):
                case Control.KEEPALIVE:
                    pass
                case Control.FINALIZE:
                    self._handle(self._segmenter.flush())
                case Control.END:
                    self._handle(self._segmenter.flush())
                    self._outbox.put_nowait(_END)
                    return

    def _decode_pcm(self, data: bytes) -> np.ndarray:
        data = self._odd_byte + data
        whole = len(data) & ~1
        self._odd_byte = data[whole:]
        return np.frombuffer(data[:whole], dtype="<i2").astype(np.float32) / 32768.0

    def _handle(self, events: list[SegmenterEvent]) -> None:
        for event in events:
            u = event.utterance
            if isinstance(event, InterimReady):
                fut = asyncio.wrap_future(self._engine.submit_interim(self.id, u.audio))
                fut.add_done_callback(lambda f, u=u: self._on_interim(u, f))
            else:
                self._engine.cancel_interim(self.id)
                text = asyncio.wrap_future(self._engine.submit_final(self.id, u.audio))
                start_ms, end_ms = self._span_ms(u)
                retracts = self._interim_shown_for == u.index
                self._outbox.put_nowait(_PendingFinal(self._segment_id(u), start_ms, end_ms, text, retracts))
                self._n_closed = u.index + 1

    def _on_interim(self, u: Utterance, fut: asyncio.Future[str]) -> None:
        # Runs on the loop thread, so this check and the enqueue are atomic with respect to
        # _handle: an interim either lands in the outbox before its final or is discarded.
        if fut.cancelled() or u.index < self._n_closed or fut.exception() is not None:
            return  # superseded, too late, or failed (the engine logged it): interims are best-effort
        if text := clean_text(fut.result()):
            self._interim_shown_for = u.index
            self._outbox.put_nowait(protocol.interim(self._segment_id(u), *self._span_ms(u), text))

    def _segment_id(self, u: Utterance) -> str:
        return f"{self.id}-{u.index}"

    def _span_ms(self, u: Utterance) -> tuple[int, int]:
        def ms(sample: int) -> int:
            return self._start.offset_ms + sample * 1000 // self._sample_rate

        return ms(u.start_sample), ms(u.end_sample)

    # --- emitter ---

    async def _emit(self) -> None:
        while (item := await self._outbox.get()) is not _END:
            if isinstance(item, dict):
                await self._ws.send_json(item)
                continue
            try:
                text = clean_text(await item.text)
            except Exception as exc:  # the final model failed on this segment; keep the stream alive
                await self._ws.send_json(
                    protocol.error(ErrorCode.INTERNAL, f"segment {item.segment_id}: {exc!r}", fatal=False)
                )
                text = ""
            if text or item.retracts_interim:
                await self._ws.send_json(protocol.final(item.segment_id, item.start_ms, item.end_ms, text))
        await self._ws.send_json(protocol.CLOSED)
        await self._ws.close(1000)

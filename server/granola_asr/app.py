"""HTTP and WebSocket routes. Model loading happens in __main__; this module only wires."""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from . import protocol
from .auth import is_authorized
from .engine import InferenceEngine
from .llm_proxy import LlmProxy
from .offline import AudioDecodeError, transcribe_file
from .protocol import ErrorCode, ProtocolError
from .segmenter import SegmenterConfig, SpeechDetector
from .session import StreamSession, send_fatal

log = logging.getLogger(__name__)

START_TIMEOUT_S = 10.0  # a connection that never sends `start` must not hold a session slot forever


def create_app(
    *,
    token: str,
    engine: InferenceEngine,
    new_detector: Callable[[], SpeechDetector],
    llm_proxy: LlmProxy,
    device: str,
    max_sessions: int,
    segmenter_config: SegmenterConfig = SegmenterConfig(),
) -> Starlette:
    active_sessions: set[str] = set()
    models = {"interim": engine.interim_model.name, "final": engine.final_model.name}

    def unauthorized() -> JSONResponse:
        body = protocol.error(ErrorCode.UNAUTHORIZED, "missing or invalid bearer token", fatal=True)
        return JSONResponse(body, status_code=401, headers={"WWW-Authenticate": "Bearer"})

    async def healthz(request: Request) -> Response:
        return JSONResponse({"ok": True, "models": models, "device": device})

    async def transcribe(request: Request) -> Response:
        if not is_authorized(request, token):
            return unauthorized()
        try:
            segments = await transcribe_file(await request.body(), engine, new_detector(), segmenter_config)
        except AudioDecodeError as exc:
            return JSONResponse(protocol.error(ErrorCode.BAD_REQUEST, str(exc), fatal=True), status_code=400)
        return JSONResponse({"segments": [asdict(s) for s in segments], "model": engine.final_model.name})

    async def llm(request: Request) -> Response:
        if not is_authorized(request, token):
            return unauthorized()
        return await llm_proxy.forward(request, request.url.path.removeprefix("/v1/"))

    async def listen(ws: WebSocket) -> None:
        if not is_authorized(ws, token):
            await ws.send_denial_response(unauthorized())
            return
        await ws.accept()
        if len(active_sessions) >= max_sessions:
            await send_fatal(ws, ErrorCode.OVERLOADED, f"server is at its limit of {max_sessions} streams", 1013)
            return
        session_id = secrets.token_hex(4)
        active_sessions.add(session_id)
        try:
            start = protocol.parse_start(await _first_text(ws))
            await ws.send_json(protocol.ready(session_id, models["interim"], models["final"]))
            session = StreamSession(ws, session_id, start, engine, new_detector(), segmenter_config)
            log.info("session %s: start %s", session_id, start)
            await session.run()
        except ProtocolError as exc:
            await send_fatal(ws, ErrorCode.BAD_REQUEST, str(exc), 1008)
        except WebSocketDisconnect:
            pass
        finally:
            active_sessions.discard(session_id)
            log.info("session %s: done", session_id)

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        engine.start()
        try:
            yield
        finally:
            await llm_proxy.aclose()
            await asyncio.to_thread(engine.stop)

    return Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Route("/v1/transcribe", transcribe, methods=["POST"]),
            Route("/v1/chat/completions", llm, methods=["POST"]),
            Route("/v1/models", llm, methods=["GET"]),
            WebSocketRoute("/v1/listen", listen),
        ],
        lifespan=lifespan,
    )


async def _first_text(ws: WebSocket) -> str:
    try:
        msg = await asyncio.wait_for(ws.receive(), START_TIMEOUT_S)
    except TimeoutError:
        raise ProtocolError(f"no start message within {START_TIMEOUT_S:g} s") from None
    if msg["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(msg.get("code", 1000))
    if msg.get("text") is None:
        raise ProtocolError('first message must be a text frame {"type": "start", ...}')
    return msg["text"]

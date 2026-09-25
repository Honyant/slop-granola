"""Wire format of docs/protocol-transcription.md: parsing client messages, building server messages."""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

SAMPLE_RATE = 16_000
ENCODING = "pcm_s16le"


class ProtocolError(Exception):
    """Client broke the protocol; reported as error{code: bad_request, fatal: true}."""


class ErrorCode(StrEnum):
    UNAUTHORIZED = "unauthorized"
    BAD_REQUEST = "bad_request"
    OVERLOADED = "overloaded"
    INTERNAL = "internal"


@dataclass(frozen=True)
class Start:
    language: str
    offset_ms: int
    interim_results: bool


class Control(StrEnum):
    FINALIZE = "finalize"
    KEEPALIVE = "keepalive"
    END = "end"


def _parse_object(text: str) -> dict[str, Any]:
    try:
        msg = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from None
    if not isinstance(msg, dict):
        raise ProtocolError("message must be a JSON object")
    return msg


def parse_start(text: str) -> Start:
    msg = _parse_object(text)
    if msg.get("type") != "start":
        raise ProtocolError('first message must be {"type": "start", ...}')
    if msg.get("sample_rate", SAMPLE_RATE) != SAMPLE_RATE:
        raise ProtocolError(f"sample_rate must be {SAMPLE_RATE}")
    if msg.get("encoding", ENCODING) != ENCODING:
        raise ProtocolError(f"encoding must be {ENCODING}")
    language = msg.get("language", "auto")
    offset_ms = msg.get("offset_ms", 0)
    interim_results = msg.get("interim_results", True)
    if not isinstance(language, str) or not language:
        raise ProtocolError("language must be a non-empty string")
    # bool is a subclass of int; reject it explicitly so `true` is not read as offset 1.
    if not isinstance(offset_ms, int) or isinstance(offset_ms, bool) or offset_ms < 0:
        raise ProtocolError("offset_ms must be a non-negative integer")
    if not isinstance(interim_results, bool):
        raise ProtocolError("interim_results must be a boolean")
    return Start(language=language, offset_ms=offset_ms, interim_results=interim_results)


def parse_control(text: str) -> Control:
    msg = _parse_object(text)
    try:
        return Control(msg.get("type"))
    except ValueError:
        raise ProtocolError(f"unknown message type {msg.get('type')!r}") from None


def ready(session_id: str, interim_model: str, final_model: str) -> dict[str, Any]:
    return {
        "type": "ready",
        "session_id": session_id,
        "models": {"interim": interim_model, "final": final_model},
        "sample_rate": SAMPLE_RATE,
    }


def interim(segment_id: str, start_ms: int, end_ms: int, text: str) -> dict[str, Any]:
    return {"type": "interim", "segment_id": segment_id, "start_ms": start_ms, "end_ms": end_ms, "text": text}


def final(segment_id: str, start_ms: int, end_ms: int, text: str) -> dict[str, Any]:
    return {"type": "final", "segment_id": segment_id, "start_ms": start_ms, "end_ms": end_ms, "text": text}


def error(code: ErrorCode, message: str, fatal: bool) -> dict[str, Any]:
    return {"type": "error", "code": code.value, "message": message, "fatal": fatal}


CLOSED: dict[str, Any] = {"type": "closed"}

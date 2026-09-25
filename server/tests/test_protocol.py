"""End-to-end protocol tests over a real WebSocket (Starlette TestClient) with fake models."""

from __future__ import annotations

import io
import json
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import numpy as np
import pytest
import soundfile as sf
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.testclient import TestClient, WebSocketDenialResponse

from granola_asr.app import create_app
from granola_asr.engine import InferenceEngine
from granola_asr.llm_proxy import LlmProxy
from tests.fakes import SR, FakeRecognizer, energy_detector, silence, to_pcm, tone

TOKEN = "t" * 32
AUTH = {"Authorization": f"Bearer {TOKEN}"}
START = {"type": "start", "sample_rate": 16000, "encoding": "pcm_s16le", "language": "en", "offset_ms": 0}


def fake_llm_upstream() -> Starlette:
    async def models(request: Request) -> Response:
        return JSONResponse({"object": "list", "data": [{"id": "gpt-oss:20b", "object": "model"}]})

    async def chat(request: Request) -> Response:
        body = await request.json()
        if not body.get("stream"):
            return JSONResponse({"choices": [{"message": {"role": "assistant", "content": "hi"}}], "echo": body})

        async def sse() -> Any:
            for word in ("hel", "lo"):
                yield f"data: {json.dumps({'choices': [{'delta': {'content': word}}]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream")

    return Starlette(routes=[Route("/v1/models", models), Route("/v1/chat/completions", chat, methods=["POST"])])


def make_client(
    final: FakeRecognizer | None = None, interim: FakeRecognizer | None = None, max_sessions: int = 4
) -> TestClient:
    engine = InferenceEngine(interim or FakeRecognizer("interim"), final or FakeRecognizer("final"))
    proxy = LlmProxy("http://upstream/v1", transport=httpx.ASGITransport(app=fake_llm_upstream()))
    app = create_app(
        token=TOKEN,
        engine=engine,
        new_detector=lambda: energy_detector,
        llm_proxy=proxy,
        device="cpu",
        max_sessions=max_sessions,
    )
    return TestClient(app)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with make_client() as c:
        yield c


def speech_with_pauses() -> np.ndarray:
    return np.concatenate([silence(0.5), tone(2), silence(1), tone(1.5), silence(1)])


def stream(ws: Any, audio: np.ndarray, chunk_ms: int = 40) -> None:
    step = SR * chunk_ms // 1000
    for i in range(0, len(audio), step):
        ws.send_bytes(to_pcm(audio[i : i + step]))


def receive_until_closed(ws: Any) -> list[dict[str, Any]]:
    messages = []
    while (msg := ws.receive_json())["type"] != "closed":
        messages.append(msg)
    return messages


def run_session(client: TestClient, audio: np.ndarray, **start: Any) -> list[dict[str, Any]]:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json({**START, **start})
        assert ws.receive_json()["type"] == "ready"
        stream(ws, audio)
        ws.send_json({"type": "end"})
        return receive_until_closed(ws)


def check_invariants(messages: list[dict[str, Any]]) -> None:
    """The guarantees the spec makes about interim/final sequencing."""
    finalized: set[str] = set()
    last_end = -1
    for msg in messages:
        if msg["type"] == "interim":
            assert msg["segment_id"] not in finalized, "interim after its final"
        elif msg["type"] == "final":
            assert msg["segment_id"] not in finalized, "two finals for one segment"
            finalized.add(msg["segment_id"])
            assert msg["start_ms"] >= last_end, "finals overlap or are out of order"
            assert msg["start_ms"] < msg["end_ms"]
            last_end = msg["end_ms"]


# --- auth ---


@pytest.mark.parametrize(
    ("url", "headers"),
    [
        ("/v1/listen", {}),
        ("/v1/listen", {"Authorization": "Bearer wrong"}),
        ("/v1/listen?token=wrong", {}),
        ("/v1/listen", {"Authorization": f"Basic {TOKEN}"}),
    ],
)
def test_websocket_rejects_bad_credentials_with_http_401(client: TestClient, url: str, headers: dict[str, str]) -> None:
    with pytest.raises(WebSocketDenialResponse) as exc, client.websocket_connect(url, headers=headers):
        pass
    assert exc.value.status_code == 401


def test_websocket_accepts_query_token(client: TestClient) -> None:
    with client.websocket_connect(f"/v1/listen?token={TOKEN}") as ws:
        ws.send_json(START)
        assert ws.receive_json()["type"] == "ready"


def test_http_endpoints_require_auth_except_healthz(client: TestClient) -> None:
    assert client.get("/healthz").json() == {
        "ok": True,
        "models": {"interim": "interim", "final": "final"},
        "device": "cpu",
    }
    assert client.get("/v1/models").status_code == 401
    assert client.post("/v1/chat/completions", json={}).status_code == 401
    assert client.post("/v1/transcribe", content=b"").status_code == 401


# --- streaming protocol ---


def test_ready_advertises_models_and_rate(client: TestClient) -> None:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json(START)
        ready = ws.receive_json()
    assert ready["type"] == "ready" and ready["sample_rate"] == 16000
    assert ready["models"] == {"interim": "interim", "final": "final"}
    assert ready["session_id"]


def test_full_session_produces_ordered_interims_and_finals(client: TestClient) -> None:
    messages = run_session(client, speech_with_pauses())
    check_invariants(messages)
    finals = [m for m in messages if m["type"] == "final"]
    assert len(finals) == 2
    assert finals[0]["start_ms"] == pytest.approx(200, abs=32) and finals[0]["end_ms"] == pytest.approx(2700, abs=32)
    assert finals[1]["start_ms"] == pytest.approx(3200, abs=32) and finals[1]["end_ms"] == pytest.approx(5200, abs=32)
    assert finals[0]["text"] == f"final {finals[0]['end_ms'] - finals[0]['start_ms']} ms."
    for f in finals:
        interims = [m for m in messages if m["type"] == "interim" and m["segment_id"] == f["segment_id"]]
        assert interims, "each segment gets interims while it is open"
        assert all(i["start_ms"] == f["start_ms"] and i["end_ms"] <= f["end_ms"] for i in interims)


def test_offset_ms_shifts_every_timestamp(client: TestClient) -> None:
    base = run_session(client, speech_with_pauses())
    shifted = run_session(client, speech_with_pauses(), offset_ms=3_600_000)
    spans = lambda ms: [(m["start_ms"], m["end_ms"]) for m in ms if m["type"] == "final"]  # noqa: E731
    assert spans(shifted) == [(s + 3_600_000, e + 3_600_000) for s, e in spans(base)]


def test_interim_results_false_sends_only_finals(client: TestClient) -> None:
    messages = run_session(client, speech_with_pauses(), interim_results=False)
    assert [m["type"] for m in messages] == ["final", "final"]


def test_finalize_closes_the_open_segment_mid_speech(client: TestClient) -> None:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json({**START, "interim_results": False})
        ws.receive_json()
        stream(ws, tone(1.5))
        ws.send_json({"type": "finalize"})
        final = ws.receive_json()
        assert final["type"] == "final" and final["end_ms"] == pytest.approx(1500, abs=32)
        stream(ws, tone(1))
        ws.send_json({"type": "keepalive"})
        ws.send_json({"type": "end"})
        [second] = receive_until_closed(ws)
    assert second["type"] == "final" and second["start_ms"] >= final["end_ms"]
    assert second["segment_id"] != final["segment_id"]


def test_odd_length_binary_frames_are_reassembled(client: TestClient) -> None:
    pcm = to_pcm(np.concatenate([tone(2), silence(1)]))
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json({**START, "interim_results": False})
        ws.receive_json()
        for i in range(0, len(pcm), 333):
            ws.send_bytes(pcm[i : i + 333])
        ws.send_json({"type": "end"})
        [final] = receive_until_closed(ws)
    assert final["end_ms"] == pytest.approx(2200, abs=32)


def test_silence_produces_no_segments(client: TestClient) -> None:
    assert run_session(client, silence(3)) == []


@pytest.mark.parametrize("render", [lambda a: "", lambda a: " ... "])
def test_empty_final_without_interim_is_suppressed(render: Callable[[np.ndarray], str]) -> None:
    with make_client(final=FakeRecognizer("final", render=render)) as client:
        assert run_session(client, speech_with_pauses(), interim_results=False) == []


def test_empty_final_after_interim_is_sent_to_retract_it() -> None:
    with make_client(final=FakeRecognizer("final", render=lambda a: "")) as client:
        messages = run_session(client, speech_with_pauses())
    check_invariants(messages)
    finals = [m for m in messages if m["type"] == "final"]
    assert len(finals) == 2 and all(f["text"] == "" for f in finals)


def test_final_model_failure_is_reported_and_stream_continues() -> None:
    calls = iter(range(100))

    def flaky(audio: np.ndarray) -> str:
        if next(calls) == 0:
            raise RuntimeError("CUDA error")
        return "Recovered."

    with make_client(final=FakeRecognizer("final", render=flaky)) as client:
        messages = run_session(client, speech_with_pauses(), interim_results=False)
    assert messages[0]["type"] == "error" and messages[0]["code"] == "internal" and messages[0]["fatal"] is False
    assert [m["type"] for m in messages[1:]] == ["final"] and messages[1]["text"] == "Recovered."


@pytest.mark.parametrize(
    "first",
    [
        {"type": "stop"},
        {**START, "sample_rate": 44100},
        {**START, "encoding": "opus"},
        {**START, "offset_ms": -5},
        {**START, "offset_ms": True},
    ],
)
def test_bad_start_is_a_fatal_bad_request(client: TestClient, first: dict[str, Any]) -> None:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json(first)
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "bad_request" and err["fatal"] is True
        assert ws.receive()["code"] == 1008


def test_binary_before_start_is_a_fatal_bad_request(client: TestClient) -> None:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_bytes(b"\x00\x00")
        assert ws.receive_json()["code"] == "bad_request"


def test_unknown_control_message_is_a_fatal_bad_request(client: TestClient) -> None:
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json(START)
        ws.receive_json()
        ws.send_text("not json")
        err = ws.receive_json()
        assert err["code"] == "bad_request" and err["fatal"] is True
        assert ws.receive()["code"] == 1008


def test_sessions_beyond_the_limit_are_rejected_as_overloaded() -> None:
    with make_client(max_sessions=1) as client:
        with client.websocket_connect("/v1/listen", headers=AUTH) as first:
            first.send_json(START)
            first.receive_json()
            with client.websocket_connect("/v1/listen", headers=AUTH) as second:
                err = second.receive_json()
                assert err["code"] == "overloaded" and err["fatal"] is True
        # The slot is released when the first stream ends.
        with client.websocket_connect("/v1/listen", headers=AUTH) as third:
            third.send_json(START)
            assert third.receive_json()["type"] == "ready"


def test_two_concurrent_sessions_are_independent(client: TestClient) -> None:
    audio = speech_with_pauses()
    with (
        client.websocket_connect("/v1/listen", headers=AUTH) as mic,
        client.websocket_connect("/v1/listen", headers=AUTH) as system,
    ):
        for ws in (mic, system):
            ws.send_json(START)
            ws.receive_json()
        step = SR * 40 // 1000
        for i in range(0, len(audio), step):
            mic.send_bytes(to_pcm(audio[i : i + step]))
            system.send_bytes(to_pcm(audio[i : i + step]))
        results = []
        for ws in (mic, system):
            ws.send_json({"type": "end"})
            results.append(receive_until_closed(ws))
    for messages in results:
        check_invariants(messages)
        assert sum(m["type"] == "final" for m in messages) == 2
    ids = [{m["segment_id"] for m in r} for r in results]
    assert not ids[0] & ids[1]


# --- offline transcription ---


def wav_bytes(audio: np.ndarray, rate: int, channels: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.repeat(audio[:, None], channels, axis=1), rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@pytest.mark.parametrize(("rate", "channels"), [(16000, 1), (44100, 2), (8000, 1)])
def test_transcribe_resamples_and_segments(client: TestClient, rate: int, channels: int) -> None:
    t = np.arange(5 * rate) / rate
    envelope = ((t >= 0.5) & (t < 2.5)) | ((t >= 3.5) & (t < 4.5))
    audio = (0.3 * np.sin(2 * np.pi * 220 * t) * envelope).astype(np.float32)
    resp = client.post("/v1/transcribe", content=wav_bytes(audio, rate, channels), headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "final"
    spans = [(s["start_ms"], s["end_ms"]) for s in body["segments"]]
    assert len(spans) == 2
    assert spans[0][0] == pytest.approx(200, abs=40) and spans[1][1] == pytest.approx(4700, abs=40)
    assert all(s["text"].startswith("final ") for s in body["segments"])


def test_transcribe_rejects_non_audio(client: TestClient) -> None:
    resp = client.post("/v1/transcribe", content=b"definitely not a wav", headers=AUTH)
    assert resp.status_code == 400 and resp.json()["code"] == "bad_request"


# --- LLM pass-through ---


def test_models_pass_through(client: TestClient) -> None:
    resp = client.get("/v1/models", headers=AUTH)
    assert resp.status_code == 200 and resp.json()["data"][0]["id"] == "gpt-oss:20b"


def test_chat_completion_pass_through(client: TestClient) -> None:
    body = {"model": "gpt-oss:20b", "messages": [{"role": "user", "content": "hi"}]}
    resp = client.post("/v1/chat/completions", json=body, headers=AUTH)
    assert resp.status_code == 200 and resp.json()["echo"] == body


def test_chat_completion_streaming_pass_through(client: TestClient) -> None:
    body = {"model": "gpt-oss:20b", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    with client.stream("POST", "/v1/chat/completions", json=body, headers=AUTH) as resp:
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = [line for line in resp.iter_lines() if line.startswith("data: ")]
    assert events[-1] == "data: [DONE]"
    assert "".join(json.loads(e[6:])["choices"][0]["delta"]["content"] for e in events[:-1]) == "hello"


def test_llm_upstream_down_is_a_502() -> None:
    engine = InferenceEngine(FakeRecognizer("interim"), FakeRecognizer("final"))
    app = create_app(
        token=TOKEN,
        engine=engine,
        new_detector=lambda: energy_detector,
        llm_proxy=LlmProxy("http://127.0.0.1:9/v1"),
        device="cpu",
        max_sessions=1,
    )
    with TestClient(app) as client:
        assert client.get("/v1/models", headers=AUTH).status_code == 502


def test_idle_connection_is_closed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("granola_asr.session.IDLE_TIMEOUT_S", 0.2)
    with client.websocket_connect("/v1/listen", headers=AUTH) as ws:
        ws.send_json(START)
        ws.receive_json()
        err = ws.receive_json()
        assert err["code"] == "bad_request" and err["fatal"] is True and "keepalive" in err["message"]
        assert ws.receive()["code"] == 1008

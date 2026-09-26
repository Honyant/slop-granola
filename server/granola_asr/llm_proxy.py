"""OpenAI-compatible pass-through to the host's LLM runtime (vLLM or Ollama).

Every response is streamed through unchanged, so SSE (`"stream": true`) and plain JSON
share one code path and the proxy never buffers a whole completion.

The one thing the proxy may add is a default reasoning effort. Qwen3.8 reads it from
`chat_template_kwargs`, a vLLM extension that OpenAI-style clients do not send, so the
server owns that knob for its model instead of every client learning about it.
"""

from __future__ import annotations

import json

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

# Headers that describe the hop, not the payload; the ASGI server recomputes them.
_HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"}


class LlmProxy:
    def __init__(
        self, upstream: str, reasoning_effort: str | None = None, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._upstream = upstream
        self._reasoning_effort = reasoning_effort
        # read=None: a cold model load in Ollama can take tens of seconds before the first byte.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def forward(self, request: Request, path: str) -> Response:
        headers = {"content-type": request.headers.get("content-type", "application/json")}
        body = await request.body()
        if request.method == "POST" and path == "chat/completions":
            body = self._with_defaults(body)
        upstream = self._client.build_request(request.method, f"{self._upstream}/{path}", headers=headers, content=body)
        try:
            resp = await self._client.send(upstream, stream=True)
        except httpx.HTTPError as exc:
            return JSONResponse({"error": {"message": f"LLM upstream unavailable: {exc!r}"}}, status_code=502)
        return StreamingResponse(
            resp.aiter_bytes(),
            status_code=resp.status_code,
            headers={k: v for k, v in resp.headers.items() if k.lower() not in _HOP_HEADERS},
            background=BackgroundTask(resp.aclose),
        )

    def _with_defaults(self, body: bytes) -> bytes:
        """Adds the configured reasoning effort unless the request chose one; anything unparseable passes as is."""
        if not self._reasoning_effort:
            return body
        try:
            payload = json.loads(body)
        except ValueError:
            return body
        if not isinstance(payload, dict):
            return body
        kwargs = payload.setdefault("chat_template_kwargs", {})
        if not isinstance(kwargs, dict) or "reasoning_effort" in kwargs:
            return body
        kwargs["reasoning_effort"] = self._reasoning_effort
        return json.dumps(payload).encode()

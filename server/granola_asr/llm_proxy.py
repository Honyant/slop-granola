"""OpenAI-compatible pass-through to the host's LLM runtime (Ollama).

Every response is streamed through unchanged, so SSE (`"stream": true`) and plain JSON
share one code path and the proxy never buffers a whole completion.
"""

from __future__ import annotations

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

# Headers that describe the hop, not the payload; the ASGI server recomputes them.
_HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"}


class LlmProxy:
    def __init__(self, upstream: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._upstream = upstream
        # read=None: a cold model load in Ollama can take tens of seconds before the first byte.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def forward(self, request: Request, path: str) -> Response:
        headers = {"content-type": request.headers.get("content-type", "application/json")}
        upstream = self._client.build_request(
            request.method, f"{self._upstream}/{path}", headers=headers, content=await request.body()
        )
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

"""Bearer-token check shared by HTTP routes and the WebSocket handshake."""

from __future__ import annotations

import hmac

from starlette.requests import HTTPConnection


def presented_token(conn: HTTPConnection) -> str | None:
    header = conn.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() == "bearer" and value:
        return value.strip()
    # Browser WebSocket clients cannot set headers, so the protocol also allows ?token=.
    return conn.query_params.get("token")


def is_authorized(conn: HTTPConnection, expected: str) -> bool:
    token = presented_token(conn)
    # compare_digest on bytes is constant-time in the length of `expected`; it leaks only the length mismatch.
    return token is not None and hmac.compare_digest(token.encode(), expected.encode())

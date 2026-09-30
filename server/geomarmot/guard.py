"""Access guard: only this machine's browser, only a page that holds the launch token.

The proxy uses the user's own cloud credentials, so no other web page may be able to reach it —
not a page on another site (CSRF), not a DNS-rebinding page that resolves its own name to
127.0.0.1, and not another machine on the network. Four checks, in order:

1. ``Host`` must name the loopback interface. A rebinding page sends its own hostname here, so this
   is what stops it. It applies to every route, static files included.
2. ``Origin``, when present, must be a loopback origin.
3. ``Sec-Fetch-Site``, when present, must be ``same-origin`` or ``none``.
4. API routes need a session cookie, which only a page that was handed the launch token (in the
   URL fragment the CLI opens) can obtain, through ``POST /session``.

DuckDB-Wasm makes its range requests from its own worker and cannot add headers, which is why the
session is a cookie rather than a header (see docs/decisions/0005-proxy-auth.md).
"""

from __future__ import annotations

import hmac
import secrets
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse, Response

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]", "::1"})
SESSION_COOKIE = "gm_session"
TOKEN_HEADER = "x-geomarmot-token"  # noqa: S105 - a header name, not a secret
# Routes that need a session. Everything else is the static app shell.
PROTECTED_PREFIXES = ("/proxy/", "/list", "/ai/")


def host_name(host_header: str) -> str:
    """The hostname part of a Host header, lowercased, brackets kept for IPv6."""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host.split("]", 1)[0] + "]"
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def is_loopback_origin(origin: str) -> bool:
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    name = parts.hostname.lower()
    return name in LOOPBACK_HOSTS or f"[{name}]" in LOOPBACK_HOSTS


class Sessions:
    """Launch token and the sessions it has opened. In memory: they last as long as the process."""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or secrets.token_urlsafe(32)
        self._ids: set[str] = set()

    def open(self, presented: str | None) -> str | None:
        if not presented or not hmac.compare_digest(presented.encode(), self.token.encode()):
            return None
        session = secrets.token_urlsafe(24)
        self._ids.add(session)
        return session

    def valid(self, session: str | None) -> bool:
        return bool(session) and any(hmac.compare_digest(session, known) for known in self._ids)


def refuse(status: int, message: str) -> Response:
    return JSONResponse({"detail": message}, status_code=status)


def check_request(request: Request, sessions: Sessions) -> Response | None:
    """Return a refusal, or None when the request may go through."""
    host = request.headers.get("host", "")
    if host_name(host) not in LOOPBACK_HOSTS:
        return refuse(403, "Remote access is not supported. Open GeoMarmot on this machine.")
    origin = request.headers.get("origin")
    if origin is not None and not is_loopback_origin(origin):
        return refuse(403, "Cross-origin requests are not allowed.")
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        return refuse(403, "Cross-site requests are not allowed.")
    if request.url.path.startswith(PROTECTED_PREFIXES):
        if not sessions.valid(request.cookies.get(SESSION_COOKIE)):
            return refuse(401, "No GeoMarmot session. Open the link the geomarmot command printed.")
    return None

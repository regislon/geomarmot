"""The GeoMarmot local server: the static app, a ``gs://`` range proxy, and bucket listing.

Only Google Cloud Storage is proxied, and only to its fixed endpoint. An arbitrary-URL proxy would
turn a server holding the user's credentials into an open relay; other hosts are fetched straight
from the browser and fail visibly when they decline CORS.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .guard import SESSION_COOKIE, TOKEN_HEADER, Sessions, check_request, refuse

logger = logging.getLogger("geomarmot")

GCS_ENDPOINT = "https://storage.googleapis.com"
# Read scope only: the app never writes to a bucket, and a narrower token is a smaller thing to leak.
GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"
PROXY_CHUNK_BYTES = 256 * 1024
LIST_PAGE_SIZE = 200
UPSTREAM_TIMEOUT_SECONDS = 60
# GCS bucket naming rules; anything else is refused before a URL is built from it.
BUCKET_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")

# Content-Range and Accept-Ranges are load-bearing: without them DuckDB-Wasm decides the server has
# no range support and downloads the whole object.
FORWARDED_RESPONSE_HEADERS = (
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
)

STATIC_DIR = Path(__file__).parent / "static"


def access_token() -> str | None:
    """An OAuth token from Application Default Credentials, or None to go anonymous.

    Returning None rather than raising keeps public buckets working on a machine with no
    credentials configured.
    """
    try:
        import google.auth
        import google.auth.transport.requests

        credentials, _ = google.auth.default(scopes=[GCS_SCOPE])
        credentials.refresh(google.auth.transport.requests.Request())
        return str(credentials.token)
    except Exception as exc:  # noqa: BLE001 - any auth failure means "go anonymous"
        logger.warning("No cloud credentials available, proxying anonymously: %s", exc)
        return None


def _checked_bucket(bucket: str) -> str:
    if not BUCKET_NAME.match(bucket) or ".." in bucket:
        raise HTTPException(status_code=400, detail=f"Not a valid bucket name: {bucket!r}")
    return bucket


def build_object_request(bucket: str, key: str, range_header: str | None) -> urllib.request.Request:
    """The upstream request for one object, carrying the browser's Range header through.

    The key arrives percent-decoded (Starlette unescapes path parameters), so it is re-encoded:
    object names contain spaces, colons, ``#`` and ``?``, and a raw space makes http.client refuse
    the request outright. ``safe="/"`` keeps path separators as separators.
    """
    path = urllib.parse.quote(f"{_checked_bucket(bucket)}/{key}", safe="/")
    request = urllib.request.Request(f"{GCS_ENDPOINT}/{path}")  # noqa: S310 - fixed https endpoint
    if range_header:
        request.add_header("Range", range_header)
    token = access_token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return request


def _stream(response: Any) -> Iterator[bytes]:
    """Yield the upstream body in chunks, closing it when the client goes away."""
    try:
        while chunk := response.read(PROXY_CHUNK_BYTES):
            yield chunk
    finally:
        response.close()


class RevalidatedStaticFiles(StaticFiles):
    """Serve the app shell with ``no-cache`` so an upgrade takes effect on the next load."""

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(
    sessions: Sessions | None = None,
    static_dir: Path | None = STATIC_DIR,
    proxy: bool = True,
    extra_routes: Any = None,
) -> FastAPI:
    sessions = sessions or Sessions()
    app = FastAPI(title="GeoMarmot", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.sessions = sessions

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        refusal = check_request(request, sessions)
        if refusal is not None:
            return refusal
        response = await call_next(request)
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {"status": "ok", "proxy": proxy}

    @app.post("/session")
    def open_session(request: Request) -> Response:
        session = sessions.open(request.headers.get(TOKEN_HEADER))
        if session is None:
            return refuse(401, "Wrong or missing launch token.")
        response = Response(status_code=204)
        response.set_cookie(SESSION_COOKIE, session, httponly=True, samesite="strict", path="/")
        return response

    if proxy:

        @app.get("/list")
        def list_bucket(bucket: str, prefix: str = "", page_token: str = "") -> JSONResponse:
            """One level of a bucket, folder style (``delimiter=/``), one page at a time."""
            query = urllib.parse.urlencode(
                {
                    "prefix": prefix,
                    "delimiter": "/",
                    "maxResults": LIST_PAGE_SIZE,
                    "fields": "items(name,size,updated),prefixes,nextPageToken",
                    **({"pageToken": page_token} if page_token else {}),
                }
            )
            name = urllib.parse.quote(_checked_bucket(bucket), safe="")
            request = urllib.request.Request(f"{GCS_ENDPOINT}/storage/v1/b/{name}/o?{query}")  # noqa: S310
            token = access_token()
            if token:
                request.add_header("Authorization", f"Bearer {token}")
            try:
                with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:  # noqa: S310
                    page = json.load(response)
            except urllib.error.HTTPError as exc:
                detail = (
                    f"gs://{bucket} cannot be listed ({exc.code}): it is not public and your "
                    "credentials do not grant access to it."
                    if exc.code in (401, 403)
                    else f"gs://{bucket}: {exc.reason}"
                )
                raise HTTPException(status_code=exc.code, detail=detail) from exc
            except urllib.error.URLError as exc:
                raise HTTPException(status_code=502, detail=f"Cannot reach storage: {exc.reason}") from exc
            return JSONResponse(
                {
                    "prefixes": page.get("prefixes", []),
                    "items": [
                        {"name": item["name"], "size": int(item.get("size", 0)), "updated": item.get("updated")}
                        for item in page.get("items", [])
                        # A "directory placeholder" object is the folder itself, not a file.
                        if not item["name"].endswith("/")
                    ],
                    "nextPageToken": page.get("nextPageToken", ""),
                }
            )

        @app.api_route("/proxy/gs/{bucket}/{key:path}", methods=["GET", "HEAD"])
        def proxy_object(bucket: str, key: str, request: Request) -> Response:
            """Stream one object through, preserving Range semantics."""
            if not key:
                raise HTTPException(status_code=400, detail="Missing object key.")
            upstream = build_object_request(bucket, key, request.headers.get("range"))
            upstream.method = request.method
            try:
                response = urllib.request.urlopen(upstream, timeout=UPSTREAM_TIMEOUT_SECONDS)  # noqa: S310
            except urllib.error.HTTPError as exc:
                # The real status matters: a 404 and a 403 mean very different things.
                raise HTTPException(status_code=exc.code, detail=f"gs://{bucket}/{key}: {exc.reason}") from exc
            except urllib.error.URLError as exc:
                raise HTTPException(status_code=502, detail=f"Cannot reach storage: {exc.reason}") from exc
            headers = {
                name: value
                for name, value in ((h, response.headers.get(h)) for h in FORWARDED_RESPONSE_HEADERS)
                if value is not None
            }
            headers.setdefault("accept-ranges", "bytes")
            if request.method == "HEAD":
                response.close()
                return Response(status_code=response.status, headers=headers)
            return StreamingResponse(_stream(response), status_code=response.status, headers=headers)

    if extra_routes is not None:
        extra_routes(app, sessions)

    # Mounted last and at the root, so it cannot shadow the API routes, and so every asset can be
    # referenced with a relative path.
    if static_dir is not None and static_dir.is_dir():
        app.mount("/", RevalidatedStaticFiles(directory=static_dir, html=True), name="static")
    return app

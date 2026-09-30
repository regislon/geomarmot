"""Smoke-test an installed GeoMarmot (a wheel in a fresh virtualenv), not the source tree.

    <venv>/bin/python smoke_installed.py

Starts the installed app on a free port with cloud storage pointed at a local fake, then checks:
/healthz, the bundled index page, that a foreign Host is refused, that the proxy refuses a page
without a session, and that with one it forwards a Range read. Exits non-zero on the first failure.
"""

from __future__ import annotations

import http.server
import socket
import threading
import time
import urllib.error
import urllib.request

import uvicorn

from geomarmot import app as app_module
from geomarmot.guard import Sessions

BODY = b"0123456789" * 100


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the http.server interface
        start, end = 0, len(BODY) - 1
        if self.headers.get("Range", "").startswith("bytes="):
            first, _, last = self.headers["Range"][6:].partition("-")
            start, end = int(first), int(last or end)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(BODY)}")
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.wfile.write(BODY[start : end + 1])

    def log_message(self, *args: object) -> None:
        return None


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def fetch(url: str, headers: dict[str, str] | None = None, method: str = "GET") -> tuple[int, bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers=headers or {}, method=method)  # noqa: S310 - loopback only
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def main() -> None:
    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    app_module.GCS_ENDPOINT = f"http://127.0.0.1:{upstream.server_address[1]}"
    app_module.access_token = lambda: None
    assert (app_module.STATIC_DIR / "index.html").is_file(), f"no bundled app in {app_module.STATIC_DIR}"

    token = "smoke-token"  # noqa: S105 - a test value
    port = free_port()
    application = app_module.create_app(sessions=Sessions(token))
    server = uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if fetch(f"{base}/healthz")[0] == 200:
                break
        except OSError:
            time.sleep(0.1)

    status, body, _ = fetch(f"{base}/healthz")
    assert status == 200 and b'"ok"' in body, (status, body)
    status, body, _ = fetch(f"{base}/")
    assert status == 200 and b"<title>GeoMarmot</title>" in body, status
    assert fetch(f"{base}/", {"Host": "192.168.1.20"})[0] == 403, "a foreign Host was served"
    assert fetch(f"{base}/proxy/gs/bucket/file.bin")[0] == 401, "the proxy answered without a session"

    status, _, headers = fetch(f"{base}/session", {"X-GeoMarmot-Token": token}, method="POST")
    assert status == 204, status
    cookie = headers.get("set-cookie", "").split(";")[0]
    status, body, _ = fetch(f"{base}/proxy/gs/bucket/file.bin", {"Cookie": cookie, "Range": "bytes=10-19"})
    assert status == 206 and body == BODY[10:20], (status, body)

    server.should_exit = True
    upstream.shutdown()
    print(f"smoke: the installed package from {app_module.__file__} passes")


if __name__ == "__main__":
    main()

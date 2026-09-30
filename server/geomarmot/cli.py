"""``geomarmot`` — serve the app on the loopback interface and open the browser."""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser

from .guard import Sessions


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="geomarmot", description="Spatial ETL in your browser.")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("GEOMARMOT_PORT", "8765")),
        help="port on 127.0.0.1 (0 picks a free one; default 8765)",
    )
    parser.add_argument("--no-browser", action="store_true", help="print the link instead of opening it")
    parser.add_argument("--no-proxy", action="store_true", help="disable the gs:// proxy and bucket browser")
    parser.add_argument(
        "--token",
        default=os.environ.get("GEOMARMOT_TOKEN"),
        help="launch token to use (default: a fresh random one); for development",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    from .ai import add_ai_routes
    from .app import create_app

    args = parse_args(argv)
    # Inside a container the server has to bind all interfaces for port mapping to work; the Host
    # allowlist still refuses anything but a loopback name, so this does not enable remote access.
    bind = "0.0.0.0" if os.environ.get("GEOMARMOT_IN_CONTAINER") == "1" else "127.0.0.1"  # noqa: S104
    port = args.port or _free_port()
    sessions = Sessions(args.token)
    app = create_app(sessions=sessions, proxy=not args.no_proxy, extra_routes=add_ai_routes)
    url = f"http://127.0.0.1:{port}/#t={sessions.token}"
    print(f"GeoMarmot is running at:\n\n    {url}\n\nPress Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        uvicorn.run(app, host=bind, port=port, log_level="warning")
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

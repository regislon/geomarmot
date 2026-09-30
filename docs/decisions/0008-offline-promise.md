# 0008 — What "works offline" means for v0.1

**Status:** accepted

Promised: once installed (`uv tool install geomarmot`, `pipx install geomarmot`, `docker pull`, or
`npm ci && npm run build`), the local server's first page load works with no network at all. An
uncached `uvx geomarmot` needs the network once, to download the package.

Not promised: reopening the hosted web version offline. That needs a service worker and is later
work.

The check is a Playwright test in a fresh browser profile that aborts every non-localhost request
from the first one, then loads spatial and reads a GeoPackage and an Excel file.

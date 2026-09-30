# geomarmot (local server)

Runs GeoMarmot on your own machine:

```bash
uv tool install geomarmot   # or: pipx install geomarmot
geomarmot                   # serves the app on 127.0.0.1 and opens your browser
```

The server only listens on the loopback interface. It serves the pre-built app, proxies `gs://`
objects with your own Application Default Credentials (with HTTP range support), lists buckets for
the bucket browser, and, with the `ai` extra, relays assistant requests using keys from your
environment. Remote access is not supported.

## Building the package

The wheel carries the built front-end as `geomarmot/static`. From a checkout:

```bash
npm ci && npm run build          # at the repository root: builds dist/
cd server && uv build            # the build hook copies dist/ into the package
```

`GEOMARMOT_BUILD_FRONTEND=1 uv build` runs the front-end build for you. An sdist already contains
the app, so a wheel built from it needs no Node. Editable installs (`uv sync`, for the server's own
tests) skip the front-end entirely.

Options: `geomarmot --port <n>` (0 picks a free port), `--no-browser` (print the link instead of
opening it), `--no-proxy` (no `gs://` proxy or bucket browser).

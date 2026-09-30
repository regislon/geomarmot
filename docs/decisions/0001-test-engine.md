# 0001 — Fixtures run in Chromium, on the app's own DuckDB-Wasm build

**Status:** accepted

## Context

Transformer fixtures must be checked by the same engine the app ships: DuckDB-Wasm 1.29.0, which
reports DuckDB v1.1.1, with its bundled spatial extension. Native DuckDB, or a newer Wasm build,
has a different spatial version and would pass or fail differently.

## Decision

Fixtures, contract tests and I/O tests run in headless Chromium through Playwright, against the
real bundle (a test-only Vite entry exposes a small `HarnessApi`, see `tests/harness/`).
The spike confirmed that both the `mvp` and `eh` bundles boot there, load spatial, and run
`ST_Transform` with `always_xy`.

Running fixtures in Node is an optional speed-up for later; it is not needed for correctness.

## Consequences

- `npm run test:browser` needs a Playwright Chromium (`npx playwright install chromium`).
- One engine for tests and app: a fixture that passes is evidence about what users get.

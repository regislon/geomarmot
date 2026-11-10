# Rust spike

The feasibility spike of [docs/rust-migration-plan.md](../docs/rust-migration-plan.md). Its outcome
and measurements are in [docs/decisions/0011-rust.md](../docs/decisions/0011-rust.md). The
JavaScript app is unchanged.

| Crate | What |
|---|---|
| `crates/sql` | the engine boundary: `SqlEngine`, Arrow IPC, overlay requests |
| `crates/core` | graph and node compilation, the SQL guard, the ported transformers (`src/transformers/`) |
| `crates/kernels` | the overlay kernel on native GEOS (and the rejected pure-Rust `geo` core) |
| `crates/io` | the only crate that imports terrio: vector files to and from Arrow; PostgreSQL / PostGIS tables as Arrow |
| `crates/connections` | saved database connections: details in `connections.json`, passwords in the OS keychain (ADR 0012) |
| `crates/engine` | the native host (DuckDB 1.5.4, locked), the engine process, its supervisor, `io::authorize` |
| `crates/conformance` | the fixture harness (`tests/harness/` ported), shared by native and browser runs |
| `crates/web` | `SqlEngine` over DuckDB-Wasm, through `web/bridge.js` |
| `crates/app` | the egui app, built for the desktop and for the browser |
| `web/` | the browser pages: fixtures (`index.html`) and the app (`app.html`) |

## Native

```bash
cd rust && cargo test --release
cargo run --release -p geomarmot-app   # needs target/release/geomarmot-engine and GEOMARMOT_EXTENSIONS
```

The first run compiles DuckDB and GEOS (a few minutes) and installs the extensions into
`rust/target/duckdb-extensions`; after that an engine only loads them from there.

Tests that need a PostGIS server run when `GEOMARMOT_TEST_PG=host:port:user:database` (and
`GEOMARMOT_TEST_PG_PASSWORD`) name one; otherwise they are skipped.

## Browser

```bash
npm --prefix rust/web ci
npm --prefix rust/web run build:wasm
npm --prefix rust/web run dev        # fixtures at /, the app at /app.html
npx playwright test --config rust/web/playwright.config.js   # after npm --prefix rust/web run build
```

`web/fetch-extensions.mjs` downloads the wasm extensions at build time and checks them against
`web/extensions.lock.json`; the page serves them itself.

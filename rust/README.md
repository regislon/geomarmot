# Rust spike

The feasibility spike from [docs/rust-migration-plan.md](../docs/rust-migration-plan.md). Not
part of the app yet; the JavaScript app is unchanged.

| Crate | What |
|---|---|
| `crates/engine` | the native engine host: bundled DuckDB, extensions loaded from a local directory only |
| `crates/core` | node compilation and the ported transformers (`src/transformers/`, one file per transformer) |

```bash
cd rust && cargo test --release
```

The first run compiles DuckDB (about 3 minutes) and installs the spatial extension into
`rust/target/duckdb-extensions`; after that, engines only `LOAD` from there.

`crates/core/tests/fixtures.rs` runs `transformers/<id>/tests.json` natively with the same
input tables, `readPort` rules and comparator as `tests/harness/` (gate 1).

## Spike progress

| Gate | State |
|---|---|
| 1. Fixtures on native DuckDB | AttributeFilter, FeatureJoiner, Dissolver, Reprojector, Bufferer: 22/22 cases pass on DuckDB 1.5.6 (osx_arm64). Not yet: DuckDB-Wasm, engine process, H3 and kernel cases, cross-check with the JavaScript comparator. |
| 2–7 | not started |

**Finding:** native DuckDB is 1.5.6 and the app's DuckDB-Wasm is 1.1.1. The plan pins both to the
same core where possible; `allowed_paths` (security, gate 6) also needs DuckDB ≥ 1.3, so the
DuckDB-Wasm side has to move up, not the native side down.

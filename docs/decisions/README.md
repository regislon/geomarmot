# Decision records

Short records of decisions that shape the code, one file each, numbered in the order they were made.
A record is not edited after it is accepted; a later record supersedes it instead.

| # | Decision |
|---|---|
| [0001](0001-test-engine.md) | Fixtures run in Chromium, on the app's own DuckDB-Wasm build |
| [0002](0002-offline-bundle.md) | Everything, DuckDB extensions included, is bundled and served locally |
| [0003](0003-sheetjs.md) | SheetJS comes from its own tarball and runs in a module worker |
| [0004](0004-sql-inspection-and-cancellation.md) | SQL is inspected with `json_serialize_sql`; runaway queries are cancelled, then the engine is restarted |
| [0005](0005-proxy-auth.md) | The local proxy authenticates with a launch token exchanged for a session cookie |
| [0006](0006-terms-gate.md) | The forbidden-terms gate uses a hashed deny-list |
| [0007](0007-graph-format.md) | Saved-graph format and compatibility |
| [0008](0008-offline-promise.md) | What "works offline" means for v0.1 |
| [0009](0009-ai-relay.md) | The assistant reaches a model directly or through the local server's relay, which forwards native requests |

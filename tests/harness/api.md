# HarnessApi v1

The case runner (`tests/harness/run-case.js`) talks to an app only through
`window.__geomarmotHarness`, provided by the test build's harness entry. (Before the app was
bundled, a second adapter drove the unbundled tree by URL; the baseline expectations were
captured with it and checked against the bundle when it arrived.)

| Adapter | Used for | Where the modules come from |
|---|---|---|
| `app/testing/harness-entry.js` | the Vite bundle (`vite build --mode test`) | the same application modules the production entry imports |

| Member | |
|---|---|
| `version` | `1` |
| `boot()` | start DuckDB and load spatial |
| `registerFixtureSource()` | add the test-only `FixtureSource` transformer (no inputs; `params.table`, `params.crs`) |
| `createTable(name, columns, rows)` | a typed table; GEOMETRY cells are WKT |
| `tableToParquet(name)` | the table as Parquet bytes, for source-file cases |
| `loadSourceFile(fileName, bytes)` | load bytes through the real source registry; returns the sources it made |
| `buildGraph(nodes, edges)` | nodes `{ key, type, params }` over the type's default params; edges by key; returns key → node id |
| `compile()` | `{ views, crs, error }` |
| `readPort(view)` | `{ columns: [{name,type}], rows }` with geometry as WKT, 64-bit integers and dates as text |
| `query(sql)` | rows |
| `runWriter(view, format, fileName, crs)` | `{ note, files: [{ name, bytes }] }` |
| `teardown()` | clear the graph and drop fixture tables |

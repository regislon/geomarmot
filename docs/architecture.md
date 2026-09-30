# Architecture

GeoMarmot is a static web app. Everything that touches data runs in the user's browser tab, in
DuckDB-Wasm; an optional Python server serves the app on the user's own machine and relays what a
browser cannot do by itself (reading private buckets with the user's credentials, calling a model
with a key from the environment).

```
 files, URLs, gs://          ┌───────────────────────── browser tab ─────────────────────────┐
 ───────────────────────────▶│ io/sources ──▶ graph model ──▶ compiler ──▶ views per port    │
                             │                    ▲              │  (generations, leases)     │
                             │  canvas, inspector │              ▼                            │
                             │  table, map ◀──────┴──── readers hold a lease ───┐             │
                             │                                                  │             │
                             │  assistant: tools ──▶ privacy gate ──▶ provider ─┼──▶ Claude,  │
                             │             drafts ─▶ isolated preview engine    │    OpenAI   │
                             └──────────────────────────────────────────────────┼─────────────┘
                                        optional local server (127.0.0.1):  /proxy/gs, /list, /ai
```

## Layout

| Path | What |
|---|---|
| `app/src/core/` | no DOM. `duck.js` (engines, queries, watchdog, restart), `graph/` (model, compiler, expansion of generated transformers), `sqlguard/`, `template.js`, `schema.js`, `jsonschema.js` |
| `app/src/io/` | sources (`sources.js`), remote URLs (`remote.js`), readers (`readers/`, `zarr/`), writers (`writers/`) |
| `app/src/engines/` | JavaScript geometry DuckDB cannot do: JSTS overlays and smoothing, H3 cells |
| `app/src/ui/` | the shell: canvas, inspector, table, map, modals, the compile loop, the assistant's drawer and chat |
| `app/src/ai/` | the assistant: catalogue, providers, privacy gate, tools, agent loop, drafts and previews, generated transformers (`spec/`) |
| `transformers/` | one folder per transformer, and `_kit/`, the only API they import |
| `server/` | the `geomarmot` Python package |
| `schemas/` | the graph file format, and schemas generated from the kit (`npm run build:schemas`) |

## From a file to a view

1. **Sources.** A dropped file is read into memory once and registered with DuckDB as a buffer; a
   URL is registered for HTTP range reads, so opening a remote Parquet costs its footer. Excel
   sheets and Zarr arrays are read in JavaScript and land in a table. Each source records its
   columns, row count, geometry column and CRS (`io/sources.js`, [formats.md](formats.md)).
2. **The graph.** `core/graph/model.js` holds nodes, edges, undo history and the saved-file format
   ([ADR 0007](decisions/0007-graph-format.md)). A node is a transformer type plus params.
3. **Compiling.** `createCompiler({ namespace, engine })` turns the graph into one DuckDB view per
   output port. For each node in topological order it runs the SQL guard, resolves inputs and the
   incoming CRS, then the transformer's hooks — `prepare` (tables, JavaScript engines), `sql` (one
   SELECT per port), `crs`, `check` — and creates the node's views in one transaction. The contract
   is [transformer-api.md](transformer-api.md).
4. **Reading.** Nothing is computed until something reads a view: the table's page, the map, the
   port counts, an export, an assistant tool.

## Generations and leases

A compile never drops what a reader might be using. Every compile is a new *generation* whose
relations are named after it (`m_g12_n3_output`), and only read each other. Readers take a *lease*
on the latest completed generation and release it when done; a replaced generation is retired and
dropped once its last lease ends. A new compile waits until every retired generation is gone, so at
most two exist at once. Edits arriving during a compile abort it (latest wins), and an aborted
compile's partial generation is dropped at once. A compile where a node fails still publishes: the
working part of the graph stays inspectable, the failed node reports its error, and everything
downstream reports "blocked". The UI takes every node's state from its lease, so it never shows an
older generation's rows for a node that has since changed.

## Engines

The **main engine** holds the user's sources. Interactive reads are watched: cancelled after 30 s,
and if the query does not stop, the engine is restarted and every source registered again
([ADR 0004](decisions/0004-sql-inspection-and-cancellation.md)). **Isolated engines** are separate
DuckDB instances for the assistant's previews; they hold only sampled copies and can be thrown away
at any time. Hooks run SQL through `ctx.engine`, so the same transformer runs in either. Details in
[engines.md](engines.md).

## The SQL boundary

SQL the user or the assistant writes is an untrusted *fragment*. The guard (`core/sqlguard/`)
parses each fragment in a placeholder form with DuckDB's own parser and refuses anything but one
SELECT reading the node's own inputs; the transformer then splices it with the same function that
built the placeholder form. SQL that reviewed transformer code builds around fragments is trusted
and never guarded. See [security.md](security.md).

## The assistant

A chat drawer beside the canvas. The agent loop (`ai/agent.js`) sends the conversation to a
provider (`ai/provider.js`; directly with the user's key, or through the local server's `/ai`
relay, [ADR 0009](decisions/0009-ai-relay.md)), runs the tools the model asks for (`ai/tools/`),
and sends their results back. Every result passes through the privacy gate (`ai/gate/`), which
shapes and checks it for the data level the user chose. The model proposes nodes as a **draft**;
drafts are previewed in an isolated engine and enter the graph only when the user applies them.
When no built-in transformer fits, it can write a **generated transformer**: a declarative spec of
SQL templates and calls to built-in transformers (`ai/spec/`), which the compiler expands into
ordinary nodes (`core/graph/expand.js`).

## The local server

`server/geomarmot` is a FastAPI app bound to 127.0.0.1. It serves the built app, proxies `gs://`
objects with the user's Application Default Credentials (range requests preserved), lists buckets,
and relays assistant requests. Every route but the static files needs a session cookie that only a
page opened with the launch token can get. Without a server — on GitHub Pages — the app finds that
`./healthz` does not answer and hides what needs one.

## Boot

`main.js`: trade the launch token for a session; ask whether a server is there; boot DuckDB with
the bundled extensions; install the generated transformers kept in this browser; restore the
autosaved graph; compile.

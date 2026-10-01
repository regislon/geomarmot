# The transformer API (apiVersion 1)

A transformer is one folder under `transformers/<kebab-name>/` holding `index.js` (the declaration),
`README.md` (user docs, rendered in the `?` panel) and `tests.json` (fixtures). It imports only from
`transformers/_kit/`. Adding one is a one-line import in `transformers/index.js`.

```js
import { defineTransformer, API_VERSION, param, SINGLE_IN, SINGLE_OUT, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeKeeper",            // stable: the type saved in graphs
  group: "Attributes",
  summary: "Keeps only the listed attributes, in the order given.",
  description: "…",                 // ≥ 60 words — see "Documentation rules" in docs/params.md
  whenToUse: ["…", "…"],
  whenNotToUse: ["…"],
  keywords: ["…", "…", "…"],
  examples: [{ input: "…", params: "…", output: "…" }],
  inputs: SINGLE_IN,
  outputs: SINGLE_OUT,              // or (params) => ports, for ports that depend on params
  params: [param.columns("columns", "Attributes to keep", { description: "…" })],
  sql: (ctx) => ({ output: `SELECT ${ctx.params.columns.map(qid).join(", ")} FROM ${ctx.inputs.input}` }),
});
```

## Fields

| Field | |
|---|---|
| `apiVersion` | `1` |
| `id` | PascalCase, stable. A later rename adds the old id to `aliases`. |
| `name` | display name; defaults to `id` |
| `group` | palette group: Source, Attributes, Filters, Combine, Reshape, Geometry, Analysis, H3, Output |
| `role` | `"transform"` (default), `"source"` (no inputs), or `"sink"` (no outputs, has `write`) |
| `summary`, `description`, `whenToUse`, `whenNotToUse`, `keywords`, `examples` | required documentation, checked by `npm run check:docs` |
| `inputs` | `[{ id, label, description }]`, static |
| `outputs` | `[{ id, label, description }]`, or `(params) => ports` |
| `params` | built with `param.<kind>(id, label, options)`; the kinds are in docs/params.md |
| `paramsVersion`, `migrations` | a param shape change bumps `paramsVersion` and adds `migrations[old] = (params) => params` (pure) |
| `aliases` | older ids that load as this transformer |
| `needs` | `{ schema, rowCount, lonLat }` — what the compiler must compute before the hooks run |
| `sql(ctx)` | required except for sinks |
| `crs(ctx)`, `prepare(ctx)`, `check(ctx)` | optional hooks |
| `write(ctx)` | sinks only |
| `action` | `{ id, label }` for a button in the inspector (the Writer's "Write this file") |
| `aiUsable` | whether the assistant may propose this transformer; `false` for sources and sinks |

## The context object

Rebuilt for each node on each compile.

| Field | Meaning |
|---|---|
| `params` | a deep copy of the node's params; changing it has no effect |
| `inputs` | `{ portId: relationName }` |
| `schemas` | `{ portId: [{ name, type }] }` when `needs.schema`, else `null` |
| `incomingCrs` | the one CRS of every connected input (`EPSG:4326` for a node with no inputs). Inputs in different CRSs are an error before any hook runs. Read-only. |
| `rowCount`, `source` | when `needs.rowCount`: the first input's row count, and the nearest upstream source's descriptor |
| `sources` | for sources: `get(id)` and `relation(source, { rowNumber })` |
| `tableName(suffix)` | `<ns>_g<gen>_t_<nodeId>_<suffix>`. Deterministic within a compile. In `prepare` it allocates the name; in `sql` and `check` a suffix `prepare` did not allocate is an error. |
| `state` | a plain object shared by the hooks of one node in one compile, then discarded |
| `signal`, `limits` | an `AbortSignal` that `prepare` must check between batches, and the caps it must honour |
| `engine` | where the hooks run SQL: `await ctx.engine.exec(sql)`, `await ctx.engine.query(sql)` (rows as objects). Never import the main engine: the same hook runs in an isolated DuckDB instance for the assistant's previews. The JavaScript geometry engines (`createShapeTable`, `createCellGeometryTable`, …) take it as their last argument or `engine` option. |

## The order hooks run in

For each node, in topological order:

0. **The SQL guard**, for a restricted node: every SQL-bearing parameter value is validated in its
   context (docs/security.md) before anything else. A refusal stops the node with
   `SQL_FORBIDDEN_CONSTRUCT`.
1. Resolve the inputs. An unconnected port, or an upstream that produced nothing, is an error.
2. Compute `incomingCrs`; apply the `needs.lonLat` gate.
3. Fill the `needs` fields.
4. **`prepare(ctx)`** → `Promise<void>`. The only hook that may create database objects: tables only,
   named with `ctx.tableName()`. They belong to the compile's generation.
5. **`sql(ctx)`** → `{ [outputPortId]: selectSql }`. Synchronous and pure; exactly one key per port
   of `outputs(params)`; each value a single SELECT. Untrusted fragments are spliced only with the
   kit's `spliceQuery` / `spliceExpression` — the same functions the guard validated them through.
6. **`crs(ctx)`** → the output stream's CRS; defaults to `incomingCrs`.
7. **`check(ctx)`** → throws to refuse, after `sql` and before anything is published.
8. **Publish**: the node's views are created in one transaction. If any fails, none is created.

## Generations, leases and the resource rule

Every compile is a new generation, and everything it creates carries it in its name. A compile only
creates its own generation's relations, which only read each other. Readers take a **lease** on the
latest completed generation (`compiler.acquire()` → `{ views, crsByNode, states, retain(), release() }`).

- **(a) Published resources** are dropped only when their generation has been replaced (retired) and
  its lease count is zero. Removing a node or recompiling never drops a leased generation.
- **(b) Unpublished resources** — a failed node's, or an aborted compile's — are dropped at once.

A compile waits **before allocating** its generation until every retired generation is gone, so at
most two exist at any time. Compile requests coalesce: a new request aborts the running compile and
only the newest runs.

A compile always publishes, even when a node fails: nodes that compiled are there, the failed node
has `{ status: "error", message }`, and everything downstream of it `{ status: "blocked" }`. The UI
shows those states, never an older generation's rows for an edited node.

## Roles

- **Source** (the Reader): no inputs; `sql` builds its relation from `ctx.sources`.
- **Sink** (the Writer): no outputs; never compiled. `write(ctx)` → `Promise<{ file, note }>` is
  called by Run (the toolbar button that writes every connected Writer), with `ctx.inputs` the upstream relations and `ctx.incomingCrs` their CRS.

## Tests

`tests.json` next to `index.js` — the format is in docs/params.md under "Fixtures". The contract
itself is checked by `tests/browser/contract.spec.js` and `tests/browser/lifecycle.spec.js`.

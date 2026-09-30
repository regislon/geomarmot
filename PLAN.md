# GeoMarmot — implementation plan

> Spatial ETL in your browser. Wire transformers on a canvas and let the marmot tunnel through your
> Parquet, GeoPackage and Excel. Your data never leaves the burrow.

This plan rebuilds the existing browser-native spatial ETL (≈10k lines of vanilla JS + a small
FastAPI proxy) as an independent open-source project in this repository, with four goals on top of
feature parity:

1. **AI-first** — the repository is built to be developed *by* AI coding agents with humans
   reviewing, and the app itself lets a user create a transformer from a prompt (section 3b).
2. **Easy to maintain** — clear module boundaries, a real build, lint/format/typecheck, tests in CI.
3. **Easy to extend** — one folder per transformer, a small stable contract, a scaffold command,
   fixture tests that any contributor (human or agent) can run.
4. **Easy to install and run locally** — like GeoLibre: a hosted web version, `uvx geomarmot` on a
   laptop, a Docker image, and later a desktop app.

---

## 0. Ground rules

- **Independent project.** No reference to the organisation it came from: no company name, no
  internal bucket names, no internal repos, no internal people. The organisation-specific
  administrative-boundaries source transformer is not ported.
- **No mention of any commercial ETL product.** Transformer names are plain descriptive English.
  The current reprojection transformer and the rejection attribute use a vendor's vocabulary
  and are renamed to **`Reprojector`** and **`rejection_code`**. Help texts are rewritten in our
  own words.
- **Credit where it is due.** Transformers modelled on WhiteboxTools keep an MIT attribution in
  their folder; libraries are credited in `NOTICE`.
- **Fresh history.** The repo starts clean (no `git filter-repo`), so nothing internal can leak
  through old commits.
- **Licence: Apache-2.0** (patent grant; compatible with every dependency: DuckDB-wasm MIT,
  MapLibre BSD-3, h3-js Apache-2.0, JSTS EDL/EPL, zarrita MIT, SheetJS CE Apache-2.0).
- **Parity first, improvements second.** Phases 1–5 reproduce today's behaviour exactly, proven by
  tests; engine upgrades and new features come after (phase 7).

---

## 1. What must be replicated (the parity checklist)

Every line below becomes either a fixture test (T) or an end-to-end check (E).

**Reading**
- [ ] Parquet / GeoParquet, local drop and remote URL with HTTP range reads (E)
- [ ] GeoPackage (one layer per row in the Layers rail), GeoJSON / `.json`, FlatGeobuf via GDAL (T)
- [ ] CSV / TSV / `.gz` via DuckDB's sniffer (T)
- [ ] Excel `.xlsx` / `.xlsm` in a worker: two-step dialog (sheets, then header row with an
      Excel-like preview and a suggested row), per-cell type inference, local-time dates rounded
      to the second, empty unnamed columns dropped (T + E)
- [ ] Zarr v2/v3 stores through the picker with a priced read plan (E)
- [ ] CRS detection per source, CRS override on the Reader, reprojection to lon/lat on read (T)
- [ ] Bucket browser (generic: type a bucket; no preset list) through the optional local proxy (E)
- [ ] Loading bar with real download/row progress and a sweep for unknown stages (E)

**Transformers — 51** (everything except the organisation-specific boundaries source)
- Source: Reader
- Attributes: AttributeKeeper, AttributeRemover, AttributeRenamer, AttributeCreator, AttributeManager
- Filters: Tester, AttributeFilter, TestFilter, DuplicateFilter
- Combine: FeatureJoiner, Unioner, AreaOnAreaOverlayer
- Reshape: Sorter, Aggregator, StatisticsCalculator, Dissolver, Bufferer, BoundingBoxReplacer,
  Sampler, SQLTransformer
- Geometry: VertexCreator, CoordinateSystemSetter, Reprojector, CentroidVector,
  RepresentativePointVector, MinimumConvexHull, SimplifyFeatures, MergeLineSegments,
  EliminateCoincidentPoints, MinimumBoundingBox, MinimumBoundingCircle, DensifyFeatures,
  SmoothVectors
- Analysis: AddGeometryAttributes, ListUniqueValues, FilterVectorFeaturesByArea,
  AttributeCorrelation, AttributeHistogram
- H3: PolygonToH3, PositionalH3Index, H3GeometryFromIndex, H3GeometryFromPosition
- Output: Writer

(The exact list is regenerated from the source during phase 3 and diffed against this one.)

**Writing** — Parquet, GeoParquet (with the metadata self-check and `.geo.json` sidecar), GeoJSON
(assembled in SQL, CRS member when projected), CSV, Excel (worker; geometry as WKT; 64-bit
integers past 2^53 as text; real date cells as serials; row / 32,767-char limits) (T)

**Workbench** — canvas (drag, connect, arrange, undo/redo), inspector generated from params (incl.
the `valuespec` builder and `?` help), attribute grid, map panel (reprojects for display, refuses
non-degree coordinates), per-feature geometry info, H3 dense-tile view, save/open graph, autosave (E)

---

## 2. Target architecture

```
geomarmot/
├── app/                         # the browser application (Vite)
│   ├── index.html
│   └── src/
│       ├── core/                # no DOM: engine + graph
│       │   ├── duck.js          # DuckDB-wasm boot, registration, query helpers
│       │   ├── graph.js         # node/edge model, compile to views, CRS propagation
│       │   ├── schema.js        # column introspection, geometry detection, CRS
│       │   └── valuespec.js
│       ├── io/
│       │   ├── readers/         # parquet, ogr, csv, xlsx (+ worker), zarr — one module each
│       │   ├── writers/         # parquet, geoparquet, geojson, csv, excel — one module each
│       │   └── remote.js        # URL resolution, optional proxy detection
│       ├── engines/             # heavy JS work, each in a Web Worker
│       │   ├── jsts.worker.js   # overlay, min box/circle, densify, smooth
│       │   └── h3.js
│       ├── ui/                  # canvas, inspector, palette, table, mapview, modals, progress
│       └── main.js
├── transformers/                # ← the contribution surface
│   ├── _kit/                    # defineTransformer, param kinds, shared helpers (public API)
│   ├── vertex-creator/
│   │   ├── index.js             # the declaration
│   │   ├── README.md            # user docs; also rendered in the "?" panel
│   │   └── tests.json           # fixtures: input → expected output per port
│   ├── coordinate-system-setter/
│   ├── …                        # one folder per transformer
│   └── index.js                 # registry: one import line per transformer
├── server/                      # optional local server (Python package "geomarmot")
│   ├── pyproject.toml
│   └── geomarmot/
│       ├── cli.py               # `geomarmot` → serve app, open browser
│       ├── app.py               # FastAPI: static files + /proxy + /list
│       └── static/              # built front-end, copied in at release time
├── tests/
│   ├── transformers.test.js     # runs every transformers/*/tests.json
│   ├── io/                      # reader/writer round-trips (xlsx dates, excel limits, …)
│   └── e2e/                     # Playwright smoke tests of the real UI
├── scripts/
│   └── new-transformer.js       # `npm run new-transformer -- MyThing` scaffolds a folder
├── docs/                        # architecture, transformer API, param kinds, engines
├── .github/workflows/           # ci.yml, pages.yml, release.yml
├── CONTRIBUTING.md  README.md  LICENSE  NOTICE  CODE_OF_CONDUCT.md
└── package.json
```

### Key decisions

| Decision | Choice | Why |
|---|---|---|
| Build | **Vite** | Today every dependency comes from a CDN at runtime, which rules out offline use, a desktop app and reproducible releases. Vite bundles them, handles Web Workers natively, and keeps dev as fast as today. |
| Language | **JavaScript + JSDoc types, checked by `tsc --checkJs`** | Parity port without a rewrite; contributors get types and editor help from `_kit` JSDoc. A move to TypeScript stays possible later, file by file. |
| Lint / format | ESLint + Prettier | Automatic, no style debates in reviews. |
| Engine pinning | keep **duckdb-wasm 1.29.0** until parity is proven | Several transformers work around this version's gaps; upgrading is phase 7, behind the test suite. |
| Registry | explicit `transformers/index.js`, one import per line | No build magic; each new transformer is a one-line, conflict-free diff. |
| Proxy | optional, Python, **uses the user's own credentials** | The app runs fully static; the proxy only adds cloud buckets without CORS (GCS today, S3 later). |

---

## 3. The transformer contract (`transformers/_kit`)

The whole point of the project. It is frozen in phase 3 and versioned (`apiVersion: 1`).

```js
import { defineTransformer, param } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: 1,
  name: "CoordinateSystemSetter",
  group: "Geometry",
  summary: "Assigns a coordinate system without changing any coordinates.",
  inputs: ["input"],
  outputs: ["output"],
  params: [param.crs("crs", "Coordinate System", { required: true })],

  // Required. Returns SQL per output port; each becomes a lazy view.
  sql: ({ params, inputs }) => ({ output: `SELECT * FROM ${inputs.input}` }),

  // Optional hooks.
  crs: ({ params, incoming }) => params.crs || incoming,   // relabel the stream's CRS
  check: async ({ params, probeCrs }) => probeCrs(params.crs), // validate before publishing
  // prepare: async (ctx) => { … }   // JS-side work (JSTS, h3) that writes tables SQL can join
});
```

- **Context object instead of positional arguments:** `{ params, inputs, schema, crs, rowCount }`.
- **Param kinds are public API** and documented once in `docs/params.md`: `string`, `number`,
  `select`, `column`, `columns`, `valuespec`, `crs`, `conditions`, `renames`, `sorts`,
  `aggregates`, `rules`, `joinkeys`, `sqltext`, `values`, … Each has a `when` for conditional
  display.
- **Four engine patterns**, in order of preference (documented in `docs/engines.md`):
  1. pure SQL (lazy, preferred)
  2. SQL + `prepare` in a worker (JSTS, h3-js) for what DuckDB spatial cannot do
  3. `crs` / `check` hooks
  4. *(phase 7)* external WASM engine (Whitebox), file round-trip in a worker
- **Help comes from the folder's `README.md`**, so docs and code cannot drift apart.
- **A detailed description is compulsory** (the documentation rules below): it feeds the help
  panel, the assistant's catalogue and coding agents alike.

### `tests.json` format

```json
{
  "cases": [
    {
      "name": "Add Point on a 2D line closes it into a polygon",
      "params": { "mode": "Add Point", "x": { "kind": "Value", "type": "Number", "value": "0" }, "y": { "kind": "Value", "type": "Number", "value": "0" } },
      "input": [{ "id": "line", "geometry": "LINESTRING (0 0, 1 0, 1 1)" }],
      "expect": { "output": [{ "id": "line", "geometry": "POLYGON ((0 0, 1 0, 1 1, 0 0))" }], "rejected": [] }
    }
  ]
}
```

Geometry is written as WKT in and out; the harness converts and compares with a tolerance. The
cases already worked out by hand for VertexCreator, CoordinateSystemSetter and the Excel reader
become the first fixtures.

### Documentation rules, enforced by CI (`npm run check:docs`)

Every transformer **must** be described in detail. The description is read by three audiences —
users (the `?` help panel), the in-app assistant (the catalogue it searches and reasons over) and
coding agents (when they reuse or modify it) — so it is part of the contract, not an extra. A PR
cannot merge unless all of these hold.

**In `index.js` (structured, machine-read):**

| Field | Rule |
|---|---|
| `summary` | one sentence, 20–160 characters, says what it produces |
| `description` | ≥ 60 words: what it does, how, and what it does *not* do |
| `whenToUse` | ≥ 2 concrete situations, phrased the way a user would ask (*"turn lon/lat columns into points"*) |
| `whenNotToUse` | ≥ 1 situation, naming the transformer to use instead where one exists |
| `keywords` | ≥ 3, including synonyms users might type (*point, XY, coordinates, geocode*) |
| each param | `label` and a `description` ≥ 10 words; allowed values explained for every `select` option; units stated (m, degrees, km…) |
| each port | a `description` of what arrives there (incl. why rows go to a rejected port) |
| `examples` | ≥ 1 worked example: input → params → output, in words (a fixture can double as one) |

**In `README.md` (human-read, rendered in the help panel), fixed headings in this order:**
*What it does · When to use it · When not to use it · Parameters · Output ports · Examples ·
Limitations · Credits.* An empty or missing heading fails the check.

The checker also flags descriptions that just repeat the name ("VertexCreator creates
vertices"), `TODO`/placeholder text, and params whose description is identical to their label.
The scaffold (`npm run new-transformer`) creates all fields and headings with guidance comments,
so the rules are met by filling the template in.

### Test rules, enforced by CI (`npm run check:fixtures`)

A PR cannot merge unless all of these hold; the check is a **required status check** on `main`.

| Rule | Limit |
|---|---|
| Every transformer folder has a `tests.json` | missing or empty file → fail |
| Every output port is exercised (incl. `<Rejected>`-style ports; an expected empty result counts) | untested port → fail |
| At least one case per mode / main option of a `select` param | uncovered option → warning, fail from v0.2 |
| File size | ≤ **50 KB** per `tests.json` |
| Rows per case | ≤ **50** input rows per port |
| Every case passes on the app's own engine (duckdb-wasm, same version as the bundle) | any failure → fail |

Large-data behaviour (row limits, performance) is **not** fixture material; it lives in an
optional `bench/` suite that never blocks a merge.

---

## 3a. AI-first development

GeoMarmot is **AI-first**: most code, transformers and docs are expected to be written by AI
coding agents (Claude Code, Codex, Cursor, …) under human review. That shapes the repository.

**Principles**
- **Tests are the specification.** An agent works from `tests.json` fixtures, and a change is done
  when the fixtures pass. Humans review behaviour (fixtures, READMEs) more than code.
- **Small, local, predictable files.** One transformer per folder, one reader/writer per module,
  no file over ~400 lines. An agent should need only the contract, one example and the target
  folder in its context.
- **Machine-readable contracts.** The transformer contract and every param kind have a JSON
  Schema (`schemas/transformer.schema.json`, `schemas/params.schema.json`) generated from `_kit`,
  so agents and the in-app builder validate against the same source of truth.
- **One command to verify everything.** `npm run check` = lint + typecheck + unit + fixture
  tests + forbidden-terms gate. Agents run it before every commit; CI runs it on every PR.
- **AI contributions are welcome and labelled.** PRs may be AI-written; the template asks which
  agent was used and requires the fixtures to have been read by a human.

**Repository files for agents**

| File | Purpose |
|---|---|
| `AGENTS.md` | The agent brief (read by Codex, Cursor, …): architecture in one page, the golden rules, `npm run check`, where things live, what never to do. |
| `CLAUDE.md` | A one-line pointer to `AGENTS.md` plus Claude Code specifics, so there is one source of truth. |
| `.claude/commands/new-transformer.md` | Slash command: scaffold, write fixtures first, implement, run `npm run check`, write the README. |
| `.claude/commands/port-whitebox-tool.md` | Phase 7: port a Whitebox tool with the WASM Whitebox as test oracle. |
| `llms.txt` | Index of the docs for any LLM (the llms.txt convention), pointing at `docs/*.md`. |
| `docs/transformer-api.md`, `docs/params.md`, `docs/engines.md` | Written for agents first: exact contract, every param kind with an example, the four engine patterns with when to use each. |
| `examples/` | Three reference transformers (pure SQL, SQL + `prepare`, `crs` hook) kept deliberately small, used as few-shot examples by agents and by the in-app builder. |

**Workflow for adding a transformer (human or agent)**
1. `npm run new-transformer -- MyThing` scaffolds the folder.
2. Write `tests.json` first: inputs and expected outputs, including edge cases and rejections.
3. Implement `index.js` against the contract; run `npm run check` until green.
4. Write `README.md` from the template; open a PR. The PR shows the fixtures up front for review.

## 3b. AI assistant in the app

The user types what they want in plain words, with their own API key, and the assistant **builds
the graph for them**: it finds the right existing transformers, reads the data to choose the right
columns and settings, and proposes the nodes on the canvas. Writing a *new* transformer is the
fallback when nothing in the catalogue fits.

### Mode A — Build the graph (primary)

Example: the user selects the Reader on `swiss.xlsx` and asks *"I want to create points out of the
Excel file"*.

1. The assistant inspects the selected node: columns `city`, `E`, `N` and their types.
2. It asks for column statistics (min/max, null share, a few distinct values): `E` runs from
   2.50M to 2.68M and `N` from 1.12M to 1.25M, so these are coordinates, and not degrees.
3. It searches the catalogue and picks **VertexCreator**, mode *Replace with Point*, X = `E`,
   Y = `N`, Remove Attributes = Yes.
4. The value ranges match Swiss LV95, so it also proposes **CoordinateSystemSetter** =
   `EPSG:2056`, and says why and how sure it is. Where it is guessing, it asks instead of
   deciding (e.g. two plausible CRSs, or two column pairs that could be coordinates).
5. It previews the result (row count, rejected rows, the points on the map) and shows the proposed
   nodes **highlighted on the canvas** with a short explanation.
6. The user clicks **Apply** (a single undo step) or **Discard**, or refines the request in the
   chat ("use lon/lat instead", "keep the E and N columns").

**How it works: tool use.** The model gets a small set of app functions (tools) and calls them in
a loop until it has a proposal. They all run in the browser, against the user's own graph and data:

| Tool | What it does |
|---|---|
| `list_transformers(query)` | Searches the catalogue: name, group, summary, keywords, ports, param schema |
| `get_transformer(name)` | Full schema and README of one transformer |
| `inspect_node(id)` | A node's output columns, types, row count, CRS, and its current params |
| `column_stats(id, columns)` | min/max, null share, distinct count, top values (aggregates only) |
| `sample_rows(id, n)` | A few rows; **only available when the user allowed it** |
| `propose_nodes(plan)` | Adds nodes, params and connections to a **draft** on the canvas (not applied yet) |
| `preview(draft_node)` | Runs the draft node: row counts per port, errors, first rows, extent |
| `ask_user(question, options)` | Asks a clarifying question instead of guessing |

The catalogue the model searches is generated from the transformers themselves, so **every
transformer, including contributed ones, is usable by the assistant with no extra work**. The
assistant is only as good as those descriptions, which is why a detailed description is
**compulsory** for every transformer (section 3, "Documentation rules").

Nothing changes the user's graph until **Apply**. The assistant cannot run a Writer, download,
read files it was not given, or touch the network: its tools are the whole of what it can do.

### Mode B — Create a new transformer (fallback)

When no transformer or chain of transformers can do the job, the assistant says so and offers to
create one:

1. It writes a **declarative transformer spec** (JSON): name, group, summary, ports, params, and a
   **pipeline of steps**. A step is either an **SQL template** (referencing `{{input}}` and
   `{{params.x}}`) or a **call to an existing transformer**, so reviewed JavaScript-based ones
   (overlay, H3, later Whitebox) can be building blocks, e.g. *AreaOnAreaOverlayer → SQL →
   PolygonToH3*. The spec never contains JavaScript.
2. The app **validates** it against the JSON Schema, **compiles** the SQL against the real input
   schema (DuckDB `EXPLAIN`) and **runs it on a sample**. Errors go back to the model for a fixed
   number of repair rounds (e.g. 3), then to the user.
3. The user previews it and saves it as a **custom transformer**: it appears in the palette with a
   "generated" badge, is stored in the browser and in saved graphs, and can be **exported as a
   folder** (`index.js` + `README.md` + `tests.json` built from the preview) ready for a PR.

**Why no generated JavaScript.** JavaScript produced by a model would run inside the page with full
access: it could read the stored API key, send data to any server, or change the app. SQL in
DuckDB can only query the user's data, and existing transformers are reviewed code. So **the AI
composes SQL and existing transformers; genuinely new JavaScript arrives through a pull request**
(human- or agent-written, with fixtures and review). A locked-down sandbox for generated
JavaScript (a worker with no network and no access to the page) is a phase 7 idea.

### Providers and keys (bring your own key)
- **Anthropic (Claude)** and **OpenAI**, behind one small `ai/provider.js` interface (send
  messages and tool definitions, return tool calls), so adding a provider is one file.
- Claude calls use the official `@anthropic-ai/sdk` from the browser (`dangerouslyAllowBrowser:
  true`, legitimate here because the key is the user's own and never touches our servers). Default
  model **`claude-opus-5-5`**, selectable in settings (e.g. `claude-sonnet-5-5` for lower cost).
  Tools are declared with `strict: true` so arguments always match their schema, and the loop
  handles `stop_reason: "refusal"` with server-side fallbacks.
- OpenAI calls use its official SDK with function calling in the same way.
- With the local server (`uvx geomarmot`), calls can go through `localhost` instead, so the key
  lives in an environment variable and is never stored in the browser.

### Key and data safety
- Keys are stored **only in the user's browser**, by default for the session only
  (`sessionStorage`); "remember on this device" is an explicit opt-in. They never go into URLs,
  saved graphs, exports or logs, and the settings screen can delete them.
- **Three data levels, chosen by the user and shown in the chat header:**
  1. *Schema only* — column names, types, row counts (default)
  2. *Schema + statistics* — adds min/max, null shares, distinct counts, top values
  3. *Schema + statistics + sample rows* — adds a few capped rows
  Mode A's CRS detection needs level 2; at level 1 the assistant asks the user instead.
- Every tool call and its result are shown in the chat, so the user sees exactly what the model
  received.

### Testing the assistant
- **Recorded conversations** in CI: model responses are replayed, never called live, so tests are
  free and deterministic. They check that tool calls are executed correctly and that the draft
  graph is what the recorded answer asked for.
- **An eval set** of prompts with expected graphs, e.g. *"points from this Excel"* → VertexCreator
  (E/N) + CoordinateSystemSetter 2056; *"keep polygons over 5 ha"* → FilterVectorFeaturesByArea.
  It is run by hand before a release, with a key, because it costs money; results are tracked
  per model.

---

## 4. Local installation (GeoLibre-style)

| Channel | Command | What you get | Phase |
|---|---|---|---|
| Web | open `https://<you>.github.io/geomarmot/` | static build on GitHub Pages; local files + CORS-enabled URLs | 5 |
| Python | `uvx geomarmot` or `pipx install geomarmot` | local server on `localhost`, opens the browser; `gs://` works with **your** gcloud credentials | 5 |
| Docker | `docker run -p 8080:8080 ghcr.io/<you>/geomarmot` | self-hosted, same as the Python server | 5 |
| From source | `git clone … && npm install && npm run dev` | contributor setup, hot reload | 1 |
| Desktop | installers for macOS / Windows / Linux (Tauri) | offline app, native file dialogs | 7 |

The Python package ships the pre-built front-end, so `uvx geomarmot` needs no Node.js. Credentials
never leave the machine: the proxy runs on `localhost` and uses Application Default Credentials.

---

## 5. Phases

Each phase ends with a green CI and a short demo. Estimates are for one person working with an AI
assistant.

### Phase 0 — Decisions and spikes (½ day)
- Confirm licence (Apache-2.0), GitHub org/repo (`regislon/geomarmot`; the `geomarmot` org name
  is taken by an inactive account), display name **GeoMarmot**.
- **Spike: can the test harness run duckdb-wasm + spatial in Node?** If yes, fixtures run in Node
  (fast). If the spatial extension will not load there, run fixtures in headless Chromium with
  Playwright instead (slower, same engine). The harness must use the *same* engine as the app, not
  native DuckDB, whose spatial version differs.
- Spike: bundle duckdb-wasm, its workers and the spatial extension with Vite for offline use.

### Phase 1 — Scaffold and agent setup (1 day)
- Vite app, ESLint, Prettier, `tsc --checkJs`, Vitest, Playwright; `npm run dev|build|test|lint`
  and the single **`npm run check`**.
- LICENSE, NOTICE, README (description and screenshots), CONTRIBUTING skeleton, CODE_OF_CONDUCT,
  issue/PR templates (with the "which agent wrote this" field).
- **`AGENTS.md`, `CLAUDE.md`, `llms.txt`** and the `.claude/commands/` from section 3a, written
  first, so every later phase is itself done by agents following them.
- CI: `npm run check` on every PR.

### Phase 2 — Port the application (2–3 days)
- Copy the front-end into `app/src/{core,io,engines,ui}`, one module per concern, behaviour
  unchanged.
- Replace CDN imports with npm dependencies (duckdb-wasm, maplibre-gl, h3-js, jsts, zarrita,
  SheetJS from its official tarball URL in `package.json`).
- **Scrub:** company name, internal bucket list (bucket browser becomes "type a bucket"),
  internal paths and references in comments, vendor-product mentions, the organisation-specific
  boundaries source. Apply the renames from section 0 (`Reprojector`, `rejection_code`).
- Readers and writers split into one module each behind a small registry, so a new format is also
  one file.
- Grep gate in CI: fail the build if forbidden terms appear (company name, internal bucket
  prefixes, vendor product names).

### Phase 3 — Transformer kit and the split (3–4 days)
- Write `_kit`: `defineTransformer`, `param.*` builders, shared helpers (`geometryTool`,
  `jsGeometryTool`, `toCrs`, `findGeometryColumn`, value specs), all JSDoc-typed.
- Adapt `graph.js` and the inspector to the context-object contract.
- Split `transformers.js` into 51 folders, one group at a time (Attributes, Filters, …). Each gets
  its **full description** (`summary`, `description`, `whenToUse`, `whenNotToUse`, `keywords`,
  param and port descriptions, README headings) passing `check:docs`. Mechanical and AI-assisted;
  each group is its own PR.
- `npm run new-transformer -- Name` scaffolds `index.js`, `README.md` and `tests.json` and adds
  the registry line.

### Phase 4 — Tests (2–3 days)
- Fixture harness over `transformers/*/tests.json`, plus `check:fixtures` enforcing the rules in
  section 3 (file present, every port covered, ≤ 50 KB, ≤ 50 rows per case, all passing).
- Fixtures for all 51 transformers, more for the geometry ones (the VertexCreator mode × geometry
  table, Z conflicts, index rules).
- GitHub Actions: `npm run check` on every PR and on `main`; branch protection makes it required.
- I/O round-trips: Excel write → read (dates, timestamps, 64-bit ints, WKT, blank long cells),
  header-row suggestion on title-block sheets, GeoParquet metadata, GeoJSON CRS member.
- Playwright smoke: drop a file, add Reader → VertexCreator → Writer, export, compare.
- Parity checklist (section 1) ticked off; CI requires the whole suite.

### Phase 4b — AI assistant (3–4 days)
- JSON Schemas for the contract and the param kinds, generated from `_kit` (also used by coding
  agents); the searchable catalogue built from every transformer's summary, keywords and params.
- `check:docs` from section 3 (compulsory detailed descriptions) wired into `npm run check`.
- `ai/provider.js` with Anthropic and OpenAI adapters; settings for keys, model and data level.
- **Mode A:** the chat panel, the tools from section 3b, draft nodes on the canvas, Apply /
  Discard as one undo step, `ask_user` questions.
- **Mode B:** the declarative-spec runtime (SQL-template steps and calls to existing
  transformers), the validate → compile → sample-run → repair loop, custom transformers in the
  palette and saved graphs, "Export as folder".
- Tests: recorded conversations for both modes, spec validation, and a check that keys never
  appear in exports or saved graphs. The paid eval set runs by hand before each release.

### Phase 5 — Distribution (1–2 days)
- `server/` Python package: `geomarmot` CLI (serve, open browser, `--port`, `--no-proxy`),
  generic `/proxy` for `gs://` (ADC) with range support, `/list` for the bucket browser.
- Release workflow: build front-end → copy into the Python package → publish to PyPI; build and
  push the Docker image to GHCR; deploy the static build to GitHub Pages.
- Release on tag `v*`, changelog from conventional commits.

### Phase 6 — Documentation (1 day)
- `CONTRIBUTING.md`: "Add a transformer in 10 minutes", a walkthrough building a small transformer
  end to end with the scaffold, a fixture and a PR.
- `docs/architecture.md`, `docs/transformer-api.md`, `docs/params.md`, `docs/engines.md`,
  `docs/formats.md` (what each reader and writer does and does not do).
- Each transformer's README follows one template: what it does · parameters · ports · examples ·
  limits · credits.

### Phase 7 — After parity (ongoing, in any order)
- **Upgrade duckdb-wasm** to a current release; re-run fixtures; retire JS workarounds that
  newer spatial versions make unnecessary (3D `ST_MakeLine`, noding, polygonize).
- **Move JSTS work into a worker** and raise the overlay caps.
- **Whitebox engine pack** built on the WASM Whitebox toolset (MIT), in a worker, loaded on
  first use: generate transformer folders from its tool metadata; use it as the **test oracle**
  for our SQL rewrites of Whitebox-style tools.
- Rasters (Whitebox and COG readers), S3 in the proxy, `.xls` / `.ods`, named ranges in Excel.
- **Desktop app** with Tauri, reusing the same build.
- Graph file format with a version field and migrations, so saved graphs survive upgrades.

**Total to parity and first release, including the AI assistant: ≈ 14–19 working days.**

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| duckdb-wasm spatial will not load in Node for tests | Run fixtures in Playwright/Chromium instead (phase 0 spike decides) |
| Bundling duckdb-wasm workers and extensions offline is fiddly | Phase 0 spike; fall back to CDN for the extension only, documented |
| Behaviour drift while splitting 2,400 lines | Split by group, fixture tests before each group moves, parity checklist |
| Contract churn after contributors arrive | `apiVersion` in every transformer; the kit keeps old versions working |
| Leaking internal names | Fresh history + CI grep gate + a manual review before going public |
| Whitebox WASM size and single-thread speed | Lazy-load in a worker, optional pack, not in the core bundle |
| An API key leaks from the browser | Session-only storage by default, never in URLs/exports/graphs, a test that proves it; local-server mode keeps the key in an env var |
| Generated SQL is wrong but plausible | Mandatory preview on real rows, the preview exported as `tests.json`, "generated" badge in the palette |
| The assistant picks the wrong columns or CRS | Nothing is applied without the user's click; it states its reasoning and confidence; `ask_user` when two options are plausible; the eval set tracks accuracy |
| Weak metadata makes transformers hard to find or misused | Detailed descriptions are compulsory and checked by `check:docs` (length, required sections, when / when not to use, param units) |
| Users send sensitive data to a provider | Schema only by default; statistics and sample rows are explicit levels; every tool result is shown in the chat |
| AI-written PRs of low quality | Fixtures-first workflow, `npm run check` gate, human review of fixtures and README |

---

## 7. Definition of done for the first public release (v0.1.0)

- Every item in section 1 ticked, backed by a test; every transformer has a passing
  `tests.json` within the size limits and a complete description, both enforced as required
  CI checks.
- `uvx geomarmot`, the Docker image and the GitHub Pages site all work from a clean machine.
- A new contributor can add a transformer by following CONTRIBUTING.md, with no other help, and
  an AI agent given only `AGENTS.md` can do the same and get `npm run check` green.
- With their own Claude or OpenAI key, a user can ask *"create points from this Excel file"* and
  get VertexCreator (and CoordinateSystemSetter where needed) proposed with the right columns,
  applied in one click; and, when no transformer fits, create one from a prompt, preview it, save
  it and export it as a folder.
- CI green; no forbidden terms anywhere in the repository.

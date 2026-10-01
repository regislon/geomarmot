# Parity with the reference application

GeoMarmot began as a port of an existing browser ETL. Its behaviour was captured before the port as
fixture expectations (`transformers/*/tests.json`) and I/O and end-to-end tests, and every change
since has had to keep them passing. This page records the checklist and the places where GeoMarmot
deliberately differs.

## Deliberate differences

| Where | Reference behaviour | GeoMarmot | Why |
|---|---|---|---|
| FeatureJoiner, Joined port | right-side attributes were never added (a hook argument was misnamed, so the right schema was always empty) | right attributes are added, clashing names suffixed | the documented behaviour; the reference was a bug |
| Reprojection transformer | a vendor-specific name | `Reprojector` | independent naming |
| Rejected rows | a vendor-specific attribute name | `rejection_code` | independent naming |
| SQL in parameters | unrestricted | restricted to the node's input unless unrestricted is chosen explicitly | security (docs/security.md) |
| Saved graphs | an unversioned format | `geomarmot-graph` v1 | docs/decisions/0007 |
| `.csv.gz` | accepted, but failed to read: this DuckDB-Wasm build cannot decompress gzip | inflated in the browser before registration | the documented behaviour |
| Runaway queries | none; a stuck query froze the engine | cancelled, then the engine restarted with sources restored | docs/decisions/0004 |

## Checklist

Every item of PLAN.md §1, with the test that holds it. `T` = fixture or I/O test, `E` = end to end.

### Reading

| | Item | Test |
|---|---|---|
| ✅ | Parquet / GeoParquet, local drop (T) and remote URL with range reads (E) | `tests/browser/io.spec.js` › Parquet, GeoParquet; `proxy.spec.js` › range requests; decision 0005 |
| ✅ | GeoPackage, one layer per row; GeoJSON / `.json`; FlatGeobuf (T) | `io.spec.js` › GeoPackage, GeoJSON, FlatGeobuf |
| ✅ | CSV / TSV / `.gz` via DuckDB's sniffer (T) | `io.spec.js` › CSV, TSV and gzipped CSV |
| ✅ | Excel in a worker: sheet and header-row steps, per-cell types, dates, empty unnamed columns dropped (T + E) | `io.spec.js` › Excel; `e2e.spec.js` › Excel |
| ✅ | Zarr v2 through the picker, with a priced plan (E) | `zarr.spec.js` |
| ✅ | CRS per source, CRS override, reprojection to lon/lat on read (T) | `transformers/reader/tests.json`; `io.spec.js` › projected GeoPackage |
| ✅ | Bucket browser (now the Google Cloud Storage connector), type a bucket, through the local proxy (E) | `proxy.spec.js` › bucket connector |
| ✅ | Loading bar with real progress (E) | `e2e.spec.js` › loading bar |

### Transformers

| | Item | Test |
|---|---|---|
| ✅ | All 44 transformers, every output port, every main option | `transformers/*/tests.json`, run by `fixtures.spec.js`; rules by `npm run check:fixtures` |

### Writing

| | Item | Test |
|---|---|---|
| ✅ | Parquet, GeoParquet (metadata self-check), GeoJSON (CRS member when projected), CSV, Excel (WKT, 64-bit integers as text, date cells, the 32,767-character limit) (T) | `transformers/writer/tests.json`; `io.spec.js` › writers |

### Workbench

| | Item | Test |
|---|---|---|
| ✅ | Canvas: drop a file, link ports by dragging, arrange, undo/redo (E) | `e2e.spec.js` › dropping a file; `workbench.spec.js` › link, Arrange |
| ✅ | Inspector generated from params; editing a value changes the output; `?` help (E) | `workbench.spec.js` › editing a parameter, help |
| ✅ | Attribute grid, per-feature geometry panel (E) | `e2e.spec.js`; `workbench.spec.js` › feature panel |
| ✅ | Map panel: draws, reprojects a labelled stream for display, refuses non-degree coordinates (E) | `workbench.spec.js` › map |
| ✅ | H3 view with the coarsen control (E) | `workbench.spec.js` › H3 index column |
| ✅ | Save and open graph; autosave (E) | `workbench.spec.js` › save graph and autosave; `e2e.spec.js` › open graph, export |

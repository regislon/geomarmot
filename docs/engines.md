# Engines

What does the work, where its limits are, and what happens when they are reached.

## DuckDB-Wasm

DuckDB-Wasm 1.29.0 (DuckDB 1.1.1) runs in a Web Worker. Both bundles Vite ships — `mvp` and `eh`
(exception handling), chosen by the browser — are served with the app, and so are the three
extensions it loads: `spatial` (with GDAL inside it), `parquet` and `json`. Nothing comes from a
CDN: `scripts/fetch-duckdb-extensions.js` downloads the extensions at build time and checks each
against `duckdb-extensions.lock.json` (sizes and SHA-256), and the build fails when the lock does
not match the installed DuckDB-Wasm ([ADR 0002](decisions/0002-offline-bundle.md)).

At boot, spatial, parquet and json are loaded explicitly, then extension autoloading and
autoinstalling are switched off, so nothing can pull in another extension later.

**Memory.** `memory_limit` is 60% of `navigator.deviceMemory` (4 GB when the browser does not say),
capped at 4 GB, so running out gives a DuckDB error instead of a crashed tab. The Wasm build cannot
spill to disk: a query that needs more than the limit fails.

**Compiles cost memory in generations.** Views cost nothing until read, but `prepare` tables (H3
cells, JSTS shapes, overlay faces) are materialised, and at most two generations exist at once —
the one shown and the one being built. Budget for twice the largest `prepare` output. `prepare`
tables are rebuilt on every compile.

**Runaway queries.** Interactive reads (the table, the map, port counts, profiling, assistant tools)
run on connections of their own under a 30 s watchdog. When it fires, `cancelSent()` is tried
first; it stops scans, aggregates, sorts and recursive CTEs within milliseconds. Nested-loop joins
(a distance join, a cross product with an arithmetic predicate) ignore it, so if the query has not
stopped 2 s later the worker is terminated and a fresh engine booted. Every source is then
registered again — dropped files from the `File` they came from, URLs by URL, and Excel and Zarr
tables from a Parquet copy kept in memory — and the graph is recompiled. Exports have no timeout
but a Cancel button that does the same ([ADR 0004](decisions/0004-sql-inspection-and-cancellation.md)).

**Isolated engines.** `createIsolatedEngine()` boots another instance with the same extensions and
settings and a 512 MB memory limit, for the assistant's draft previews. It only ever receives
sampled copies of graph outputs (at most 1,000 rows each), and a preview that runs past 10 s is
stopped by terminating it. Transformer hooks never import the main engine: they run SQL through
`ctx.engine`, so the same code runs in both (`tests/meta/engine-use.test.js` enforces it).

## GDAL (inside spatial)

The spatial extension ships GDAL, which is how GeoPackage, GeoJSON and FlatGeobuf are read — from a
dropped buffer or over HTTP range reads — and how CRS transforms (`ST_Transform`, PROJ) work. The
Wasm build of GDAL cannot *write* GeoPackage (its SQLite cannot write to the Wasm file system), so
GeoMarmot writes GeoPackage itself, with sql.js — a WebAssembly SQLite, loaded on the first
GeoPackage export — following the OGC GeoPackage 1.3 tables and geometry encoding.

## JSTS

JSTS 2.12.1 (a JavaScript port of the JTS topology suite) does the geometry DuckDB's spatial
extension cannot: the minimum rotated bounding box and the minimum bounding circle, densifying,
smoothing, and the noding and polygonizing behind AreaOnAreaOverlayer. Everything else geometric —
centroids, hulls, simplifying, merging lines, buffers, dissolves — is spatial-extension SQL. JSTS is
loaded on first use.

It runs on the page's main thread in v0.1. Features go through it one by one, in chunks of 5,000
with a yield between, so the page keeps responding, and a superseded compile stops between chunks.
An overlay refuses more than 20,000 features (`MAX_OVERLAY_FEATURES`). This is responsiveness, not
isolation: a single enormous geometry still blocks the page while it is processed. Moving JSTS into
a worker is on the list in [debt.md](debt.md).

## h3-js

h3-js 4.2.1 computes H3 cells and their boundaries. GeoMarmot uses it for three things:

- **Cell geometry** (H3GeometryFromIndex, H3GeometryFromPosition): hexagons for the cells an input
  names, built in JavaScript and inserted as WKB in batches of 25,000 cells.
- **Polygon fill** (PolygonToH3): the cells covering each polygon, under a choice of fill mode.
- **Positional indexes** (PositionalH3Index): files named after an H3 cell whose rows are that
  cell's children in order; the index is computed in SQL from the row number.

At most 2,000,000 cells are materialised for a node (`MAX_MATERIALISED_CELLS`); past that the node
asks to sample or filter upstream. Previews use a tenth of both caps.

## zarrita

zarrita 0.7.5 reads Zarr v2 and v3 stores (consolidated metadata, sharding; blosc and zstd through
numcodecs, loaded on first use). A Zarr array is not read whole: the picker chooses one array, pins
every non-spatial dimension, and samples a window of the spatial ones. Because the chunk is the unit
of transfer, the picker prices a plan in chunks and bytes before anything is read, and the result
lands in a DuckDB table with one row per cell and real coordinates.

## SheetJS

SheetJS 0.20.3 parses Excel workbooks in a Web Worker, because neither DuckDB's excel extension nor
GDAL's XLSX driver works in the browser. A sheet picker chooses the sheets and the header row; the
cells land in a table ([ADR 0003](decisions/0003-sheetjs.md)).

# Formats

## Reading

Drop a file on the Layers rail, paste a URL or a `gs://` path, or browse a bucket (local server
only). A dropped file is read into memory and never uploaded; a URL is read with HTTP range
requests, so a remote Parquet costs its footer and the row groups a query needs.

| Format | Extensions | Read by | Notes |
|---|---|---|---|
| Parquet, GeoParquet | `.parquet`, `.pq` | DuckDB | The CRS comes from the file's `geo` metadata (GeoParquet 1.0/1.1); a geometry column without it is assumed lon/lat and flagged as assumed. The Reader can add a row number (`file_row_number`). |
| CSV, TSV | `.csv`, `.tsv`, `.csv.gz`, `.tsv.gz` | DuckDB's sniffer | Delimiter, quoting and column types are detected. A `.gz` is inflated in the browser first (this DuckDB-Wasm build cannot). A CSV carries no geometry: build one with VertexCreator or AttributeCreator. |
| GeoPackage | `.gpkg` | GDAL (in spatial) | Every layer becomes its own source; the CRS comes from the layer. Works from a URL too. |
| GeoJSON | `.geojson`, `.json` | GDAL | `.json` is tried as GeoJSON, since most REST APIs name it that way. |
| FlatGeobuf | `.fgb` | GDAL | |
| Excel | `.xlsx`, `.xlsm` | SheetJS, in a worker | Pick the sheets and the header row; title blocks above the header are skipped, dates become dates, IDs that look numeric stay text when Excel stored them as text. Macros are ignored. |
| Zarr | a store URL | zarrita | Choose one array, pin the non-spatial dimensions, sample a spatial window; the cost (chunks and bytes) is shown before anything is read. |

Shapefiles are not supported: GDAL can read one only with its `.shx` and `.dbf` beside it, and a
single dropped file cannot bring them.

**Files named after an H3 cell.** A file without geometry whose name is an H3 cell
(`866500cdfffffff.parquet`) is recognised: its rows can be read as that cell's children in order
(positional), or through a column of H3 indexes. See PositionalH3Index and the H3 transformers.

**Remote paths.** `gs://bucket/key`, `https://storage.googleapis.com/bucket/key` and
`https://bucket.storage.googleapis.com/key` are rewritten onto the local server's `/proxy/gs`
route, which adds your Application Default Credentials (or none, for public buckets) and keeps range
requests working. Other URLs are fetched directly and work when the host sends CORS headers. On a
static host with no server, `gs://` paths are refused with an explanation, and storage URLs are
fetched directly.

## Writing

A **Writer** node chooses a format and a file name; **Run** writes every connected Writer.

| Format | Geometry | Notes |
|---|---|---|
| Parquet | as DuckDB stores it | Columnar and compact. |
| GeoParquet | WKB, with a `geo` metadata block | `crs` is `null` (OGC:CRS84) for lon/lat, otherwise the CRS code. The written file is read back to check the metadata is there. |
| GeoJSON | RFC 7946 features | Lon/lat as the spec wants. A projected stream (after a Reprojector) is written in its own coordinates and named in the 2008 `crs` member, which GDAL and QGIS honour. |
| GeoPackage | GeoPackage binary (ISO WKB with a header) | One layer, named after the file, in the stream's own coordinate system (EPSG codes are recognised by GDAL and QGIS). Attributes keep their types: integer, real, text, boolean, date, datetime, blob; lists and structs become text. No spatial index is written; QGIS and GDAL build one when they need it. |
| CSV | as WKT text | |
| Excel | as WKT text | One sheet. Integers beyond 2^53 are written as text rather than rounded; dates become date cells; cells over Excel's 32,767-character limit (very long WKT) are left blank, and the export says how many. |

## Graph files

**Save ▸ To this computer** downloads `graph.flow.json`: `{ "format": "geomarmot-graph", "version": 1, nodes,
edges, custom }`, described by [`schemas/graph.schema.json`](../schemas/graph.schema.json). A graph
is a recipe: sources are referenced by name, never embedded, so opening one asks you to load the
files its Readers need. `custom` carries the specs of the generated transformers the graph uses.

A graph opened from a file comes back with every node's SQL restricted, whatever it asked for
([security.md](security.md)). Transformer renames are handled by `aliases`, param shape changes by
`migrations` ([ADR 0007](decisions/0007-graph-format.md)).

**Save ▸ To this browser** (⌘S / Ctrl+S) keeps the same content as a named workspace in this
browser, on this computer; **Open ▸ From this browser** (⌘O / Ctrl+O) lists them to open or delete.
They live in the browser's storage for this site, so clearing its site data removes them. As with a
file, a workspace holds the graph, not the data: load the files its Readers need after opening it.

## Generated transformers

A generated transformer is a JSON spec ([`app/src/ai/spec/schema.json`](../app/src/ai/spec/schema.json)):
its ports, typed params, and steps that are SQL templates or calls to built-in transformers. "Export
as folder" turns one made of SQL steps into a transformer folder (`index.js`, `README.md`,
`tests.json`) inside a `.tar`, to review and add under `transformers/`.

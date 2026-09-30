# 0002 — Everything, DuckDB extensions included, is bundled and served locally

**Status:** accepted

## Context

The app used to load every dependency from CDNs at runtime. DuckDB also fetches its extensions
from `extensions.duckdb.org` when first used.

## Findings (spike S2)

- The only extension the app downloads on boot is `spatial`. Reading and writing Parquet and
  calling JSON functions autoload `parquet` and `json` on first use.
- All three are published for `v1.1.1` on both `wasm_mvp` and `wasm_eh`. Served from the app's
  own origin and selected with `SET custom_extension_repository`, they load with every
  non-localhost request aborted from the very first request.
- h3-js, JSTS, zarrita (with its blosc/zstd/lz4 codecs), MapLibre and SheetJS all bundle with
  Vite 5, and run in the production build with the network blocked.
- GDAL inside the Wasm spatial extension **reads** GeoPackage, GeoJSON and FlatGeobuf from a
  registered buffer, but cannot **write** them (GPKG, GeoJSON and FlatGeobuf writes all fail).

## Decision

- `scripts/fetch-duckdb-extensions.js` reads the DuckDB version and platforms from the installed
  package, downloads each extension the app uses, checks each against
  `duckdb-extensions.lock.json` (size and SHA-256) and places them under
  `app/public/duckdb-extensions/`. CI fails when the lock does not match the installed version.
- There is no CDN fallback.
- GeoPackage test fixtures are generated at test time with `ogr2ogr` from GeoJSON (installed in
  CI with `gdal-bin`), never committed as binaries.

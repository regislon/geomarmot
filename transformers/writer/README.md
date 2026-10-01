# Writer

Writes the rows that reach it to a file in your browser's downloads.

## What it does

The Writer is where a graph ends. When you press **Run** in the toolbar (every connected Writer)
or **Write this file** in its inspector (just this one), it writes its input to a single file.
Nothing is uploaded: the file is assembled in the page and saved like any other download.

Every other node is a lazy view that is always current; writing a file is the one act you trigger.
An export that follows a parameter change within the typing debounce first lands that change, so it
never writes the previous version of the data.

| Format | What you get |
|---|---|
| Parquet | columnar, compact; geometry as DuckDB stores it |
| GeoParquet | Parquet with valid `geo` metadata, checked by reading the written file back; falls back to WKB with a `.geo.json` sidecar (and says so) on a build that cannot write it |
| GeoJSON | one feature per row; a projected stream names its CRS in the `crs` member |
| CSV | a plain table; geometry as WKT text |
| Excel | one sheet with a header filter; geometry as WKT; 64-bit integers past 2^53 as text; dates as real date cells |

## When to use it

- Save the result of a graph as GeoParquet for a GIS, or as GeoJSON for a web map.
- Hand a table to someone who works in a spreadsheet, as Excel or CSV.

## When not to use it

- To look at intermediate results: every node's output is already in the attribute grid and the
  map, for free.
- To write to a cloud bucket: the Writer only writes to your downloads.

## Parameters

| Parameter | |
|---|---|
| Format | Parquet, GeoParquet, GeoJSON, CSV or Excel — see the table above. |
| File name | The downloaded file's name without its extension. Characters other than letters, digits, `.`, `_` and `-` become `_`. |

## Output ports

A Writer has no output ports: it is the end of its branch. Its single input, **Input**, takes the
rows to write.

## Examples

- Points from a VertexCreator, Format GeoJSON, File name `sites` → `sites.geojson`.
- A projected stream (after a Reprojector to EPSG:2056), Format GeoJSON → a file whose `crs` member
  says `urn:ogc:def:crs:EPSG::2056`.
- A table with an H3 index column, Format Excel → the index as exact text, not a rounded number.

## Limitations

- Excel has a ceiling of 1,048,575 rows: a larger input is refused before anything is written
  (filter upstream, or write Parquet or CSV). A cell over 32,767 characters — a detailed polygon's
  WKT, typically — is left blank rather than truncated, and the status line says how many.
- A projected stream's WKT in Excel or CSV is in its own CRS, which those formats cannot record.
- An H3 stream with no geometry column gets hexagons built for GeoParquet and GeoJSON, up to the
  cell ceiling; past it, GeoJSON is refused and Parquet is written with the index only.

## Credits

Parquet, CSV and GeoJSON are written by DuckDB; Excel by SheetJS in a worker.

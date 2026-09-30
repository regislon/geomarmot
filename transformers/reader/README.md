# Reader

Reads one loaded file or layer into the graph. Every graph starts with a Reader.

## What it does

The Reader takes one source from the Layers rail and hands its rows downstream, unchanged except
for one rule: **geometry leaves the Reader in longitude/latitude (EPSG:4326)**. A projected source
— a GeoPackage in Swiss LV95, a GeoParquet in Web Mercator — is reprojected on read, so every node
below a Reader starts from the same coordinate system.

What it can read:

| Source | How |
|---|---|
| Parquet, GeoParquet | DuckDB's Parquet reader, with HTTP range requests for remote files |
| GeoPackage, GeoJSON (`.geojson`, `.json`), FlatGeobuf | GDAL, one Layers row per layer |
| CSV, TSV (and `.gz`) | DuckDB's sniffer decides delimiter, quoting and types |
| Excel (`.xlsx`, `.xlsm`) | parsed in a worker; one Layers row per chosen sheet |
| Zarr arrays | a snapshot of the cells chosen in the Zarr picker |

## When to use it

- Start a graph from a file you dropped, loaded from a URL or picked in the bucket browser.
- Read a layer whose coordinate system is missing or wrong: set **CRS override** to what the
  coordinates really are, and the Reader reprojects from that.
- Keep the physical row order of a Parquet file (**Row number** = Yes) for positional H3 tiles,
  which PositionalH3Index and H3GeometryFromPosition need.

## When not to use it

- To turn coordinate columns (lon/lat, E/N) into points — use **VertexCreator** (Replace with Point).
- To change the coordinate system in the middle of a graph — use **Reprojector**, or
  **CoordinateSystemSetter** to relabel without moving anything.

## Parameters

| Parameter | |
|---|---|
| Source | The loaded file or layer to read, chosen from the Layers rail. |
| CRS override | The coordinate system to read the geometry as. Blank uses the file's own. A CRS the file does not actually declare is never guessed: without an override, such geometry is passed through as it is. |
| Row number | **Auto** adds `file_row_number` for a dense positional H3 tile and nothing else; **Yes** always adds it (Parquet only); **No** never does. |

## Output ports

| Port | |
|---|---|
| Output | Every row of the source, with geometry in longitude/latitude. |

## Examples

- A GeoPackage layer in EPSG:2056 comes out with the same rows and attributes, its points moved
  to longitude/latitude.
- A Parquet file of points with **CRS override** `EPSG:2056` is reprojected from LV95 to lon/lat.
- A Parquet file with **Row number** = Yes gains a `file_row_number` column: 0, 1, 2, … in file order.

## Limitations

- Shapefiles are not supported: one dropped file cannot bring its `.shx` and `.dbf` companions.
- CSV and Excel carry no geometry; build it with VertexCreator or an AttributeCreator
  (`ST_GeomFromText("wkt")`).
- The physical row number exists only for Parquet: neither GDAL nor the CSV reader has one.
- Excel sheets and Zarr arrays are snapshots made when they were opened, not live views of the file.

## Credits

Reading is done by DuckDB (Parquet, CSV) and GDAL inside DuckDB's spatial extension (GeoPackage,
GeoJSON, FlatGeobuf); Excel by SheetJS; Zarr by zarrita.

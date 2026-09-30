# H3GeometryFromIndex

Builds hexagon geometry from an existing H3 index column.

## What it does

The index attribute's cells become real hexagons, so a table of cells can be buffered, dissolved,
joined spatially or exported as GeoParquet. Hexagons are built in JavaScript and materialised, hence
**Sample every Nth**: sampling uses a hash of the index, the same when building and joining, so
sampled-out rows are left out rather than left without geometry. Auto aims for about 50,000 cells;
All keeps every one. Rows with no index are dropped.

## When to use it

- Hexagons for a table with an `h3_index` column.
- Export cells as GeoParquet.

## When not to use it

- A dense positional tile — **H3GeometryFromPosition**.
- Just looking: the map draws an `h3_index` column by itself.

## Parameters

| Parameter | |
|---|---|
| Index attribute | the column with cell indexes |
| Sample every Nth | Auto, All, 10, 100, 1000, 10000 |
| Geometry attribute | name of the new geometry; default `geometry` |

## Output ports

| Port | |
|---|---|
| Output | the sampled rows with their hexagons |

## Examples

- Rows `8a1f8d7a49a7fff`, `8a1f8d7a49b7fff` and one NULL, Sample All → the two indexed rows with
  their hexagons.

## Limitations

- At most 2,000,000 cells are materialised.
- The output is longitude/latitude.

## Credits

h3-js (Apache-2.0).

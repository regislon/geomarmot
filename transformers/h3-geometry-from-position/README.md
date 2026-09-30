# H3GeometryFromPosition

Turns a dense positional tile's row order straight into indexes and hexagons.

## What it does

PositionalH3Index and H3GeometryFromIndex in one node: each row gets its `h3_index` from its
`file_row_number` and its hexagon as geometry. Rows can be sampled by row number, with the same
filter when building and joining.

| Sample | A full resolution-13 tile (823,543 rows) |
|---|---|
| Auto | about 8,000 hexagons, a fraction of a second |
| All | every hexagon, a few seconds |

## When to use it

- Hexagons for a dense tile in one step.
- Export a positional tile as GeoParquet with geometry.

## When not to use it

- Only the index — **PositionalH3Index** is free.
- A filter before the costly half — PositionalH3Index, a filter, then **H3GeometryFromIndex**.

## Parameters

| Parameter | |
|---|---|
| Parent cell | blank: from the file name |
| Child resolution | blank: from the row count |
| Sample every Nth | Auto, All, 10, 100, 1000, 10000 |
| Geometry attribute | default `geometry` |

## Output ports

| Port | |
|---|---|
| Output | the sampled rows with `h3_index` and hexagon |

## Examples

- `891f8d7a49bffff.parquet`, 7 rows, Sample All → 7 rows with index and hexagon.
- Sample 10 on 7 rows → only row 0.

## Limitations

- Needs the Reader's Row number; pentagon parents and non-power-of-seven row counts are refused.

## Credits

h3-js (Apache-2.0).

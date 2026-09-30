# PolygonToH3

Fills polygons with H3 cells — one row per cell, carrying its polygon's attributes.

## What it does

Each polygon is covered with cells at the chosen resolution; each (polygon, cell) pair becomes a row
with the polygon's attributes, the cell's `h3_index` and, by default, the cell's hexagon as geometry
(the polygon itself is dropped). Fill modes, named as h3ronpy names them, each a superset of the one
before:

| Mode | Takes a cell when |
|---|---|
| ContainsCentroid (default) | its centroid is inside the polygon |
| ContainsBoundary | the whole cell is inside |
| Covers | it overlaps the polygon at all |
| CoversBoundingBox | it overlaps the polygon's bounding box |

The fill runs in JavaScript with h3-js (DuckDB-Wasm has no H3 extension).

## When to use it

- Grid farms onto resolution-9 cells.
- Aggregate polygon attributes onto a hexagon grid.

## When not to use it

- Hexagons for an existing index — **H3GeometryFromIndex**.
- A dense positional tile — **PositionalH3Index**.

## Parameters

| Parameter | |
|---|---|
| Resolution | 0–15 |
| Polygon fill mode | see the table |
| Index attribute | name of the index column; default `h3_index` |
| Geometry | **Hexagons** or **None (index only)** |

## Output ports

| Port | |
|---|---|
| Output | one row per (polygon, cell) |

## Examples

- A small polygon near Zurich at resolution 7: ContainsCentroid gives the fewest cells,
  CoversBoundingBox the most.

## Limitations

- Longitude/latitude polygons only.
- At most 2,000,000 cells per fill; the node says so rather than locking the tab.

## Credits

h3-js (Apache-2.0).

# Dissolver

Merges the geometry of every row in a group into one shape.

## What it does

Rows are grouped by the chosen attributes and each group's geometries merged with `ST_Union_Agg`:
shared borders disappear, so districts become one outline, not a collection. Each output row has the
group values, the merged geometry and `parts` — how many rows went in. With no attributes chosen,
the whole input becomes one shape.

## When to use it

- One outline per region from its districts.
- Merge overlapping buffers into one area.

## When not to use it

- Totals per group without the shape — **Aggregator**.
- Keeping overlaps as separate pieces — **AreaOnAreaOverlayer**.

## Parameters

| Parameter | |
|---|---|
| Dissolve by | attributes defining the groups; empty = one shape |

## Output ports

| Port | |
|---|---|
| Output | group values, merged geometry, `parts` |

## Examples

- Three unit squares, two `farm` and one `forest`, by `cat` → `farm`: a 2×1 rectangle, parts 2;
  `forest`: a square, parts 1.

## Limitations

- Attributes other than the group values are dropped.
- Needs a geometry column; after PolygonToH3 set its Geometry to Hexagons first.

## Credits

`ST_Union_Agg` from DuckDB spatial (GEOS).

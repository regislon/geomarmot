# BoundingBoxReplacer

Replaces geometry with its bounding box — per feature, or one box for everything.

## What it does

**Per feature**: each geometry becomes its axis-aligned envelope; attributes are kept.
**One box for everything**: the whole input collapses to one row with the overall extent; no other
attributes survive, since one row cannot carry every row's values. By default `minx`, `miny`,
`maxx` and `maxy` are added as attributes. The box is a real GEOMETRY, visible to the map and
writers.

## When to use it

- The extent of a layer as one rectangle with its bounds.
- Envelopes instead of detailed shapes, to draw faster.

## When not to use it

- The tightest rectangle at any angle — **MinimumBoundingBox**.
- A convex outline — **MinimumConvexHull**.

## Parameters

| Parameter | |
|---|---|
| Box | **Per feature** or **One box for everything** |
| Bounds attributes | **Add minx/miny/maxx/maxy** or **None** |

## Output ports

| Port | |
|---|---|
| Output | the boxes, with bounds if asked |

## Examples

- Points (0 0) and (3 4), One box → one rectangle 0 0 – 3 4 with minx 0, miny 0, maxx 3, maxy 4.
- A line from (0 0) to (2 1), Per feature → the rectangle 0 0 – 2 1.

## Limitations

- A point's box is the point itself; a horizontal line's box is a line.

## Credits

DuckDB spatial (`ST_Envelope`, `ST_Extent_Agg`).

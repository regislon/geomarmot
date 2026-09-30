# EliminateCoincidentPoints

Drops points that share a location, within a tolerance, keeping one per spot.

## What it does

Coordinates are snapped to a grid the size of the tolerance, and the first point in each grid cell
is kept; the rest are dropped. Snapping keeps it a grouping rather than a comparison of every pair.
The tolerance is in the stream's own units.

## When to use it

- Drop GPS fixes recorded twice at the same spot.
- Clean duplicated sample sites.

## When not to use it

- Rows identical in every attribute — **DuplicateFilter**.

## Parameters

| Parameter | |
|---|---|
| Tolerance (degrees) | the snapping grid size, above zero |

## Output ports

| Port | |
|---|---|
| Output | one point per location |

## Examples

- (1 1), (1.001 1.001), (5 5) with tolerance 0.01 → two points.

## Limitations

- Two points closer than the tolerance can survive if they fall in neighbouring grid cells.
- Which of several coincident points is kept is not guaranteed.

## Credits

A DuckDB window function over snapped coordinates. Modelled on the WhiteboxTools tool of the same
purpose (MIT).

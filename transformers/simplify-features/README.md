# SimplifyFeatures

Removes vertices within a tolerance while keeping every shape valid.

## What it does

Lines and polygons lose every vertex whose removal keeps the outline within the tolerance of the
original (Douglas–Peucker, topology-preserving): a polygon never becomes self-intersecting, so
areas measured afterwards stay meaningful. The tolerance is in the stream's own units — on lon/lat,
0.001° is roughly 100 m. Points are unchanged.

## When to use it

- Lighten detailed coastlines before drawing or exporting them.
- Remove near-collinear vertices.

## When not to use it

- Adding vertices — **DensifyFeatures**.
- Rounding corners — **SmoothVectors**.

## Parameters

| Parameter | |
|---|---|
| Tolerance (degrees) | the largest allowed deviation, in the stream's units; not negative |

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry simplified |

## Examples

- `LINESTRING (0 0, 1 0.05, 2 0, 3 0.04, 4 0)` with tolerance 0.1 → `LINESTRING (0 0, 4 0)`.

## Limitations

- A tolerance in degrees is not the same distance at every latitude; reproject first when it matters.

## Credits

`ST_SimplifyPreserveTopology` (DuckDB spatial, GEOS). Modelled on the WhiteboxTools tool of the
same purpose (MIT).

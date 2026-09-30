# MinimumConvexHull

The convex hull of each feature, or one hull around the whole layer.

## What it does

The convex hull is the smallest convex polygon containing a geometry — a rubber band stretched
around it. **Each feature**: every geometry becomes its hull; attributes are kept. **The whole
layer**: all geometries are merged and one row with a single hull comes out, with no other
attributes. The hull of one point is the point; of collinear points, a line.

## When to use it

- An outline around a cloud of points.
- A convex version of each irregular polygon.

## When not to use it

- An axis-aligned rectangle — **BoundingBoxReplacer**.
- A tight outline following concave edges — there is no concave hull here.

## Parameters

| Parameter | |
|---|---|
| Hull around | **Each feature** or **The whole layer** |

## Output ports

| Port | |
|---|---|
| Output | each hull, or one row with the hull of everything |

## Examples

- Points (0 0), (4 0), (2 3), (2 1), The whole layer → the triangle (0 0), (4 0), (2 3).
- A U-shaped polygon, Each feature → the square around it.

## Limitations

- The whole-layer hull keeps no attributes.

## Credits

`ST_ConvexHull` (DuckDB spatial, GEOS). Modelled on the WhiteboxTools tool of the same purpose (MIT).

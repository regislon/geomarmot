# RepresentativePointVector

Replaces each feature with a point guaranteed to lie inside it.

## What it does

The point is on the surface of the feature — inside a polygon, on a line — even for shapes whose centroid falls outside. It is not the centre. Attributes ride along; null geometries stay null.

## When to use it

- Label points inside every polygon; points for point-in-polygon lookups.

## When not to use it

- The geometric centre — **CentroidVector**.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced |

## Examples

- A U-shaped polygon → a point inside one of its arms.

## Limitations

- The point's exact position is an algorithm detail; do not rely on it being central.

## Credits

`ST_PointOnSurface` (DuckDB spatial, GEOS).

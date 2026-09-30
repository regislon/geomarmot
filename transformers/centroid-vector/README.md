# CentroidVector

Replaces each feature with its centroid.

## What it does

The centroid is the centre of mass: of a polygon's area, a line's length, a multipoint's points. For a concave shape (a U, a crescent) it can lie outside the feature. Attributes ride along; null geometries stay null.

## When to use it

- One point per polygon for a thematic map; the middle of each line.

## When not to use it

- A point guaranteed on the feature — **RepresentativePointVector**.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced |

## Examples

- A 2×2 square at the origin → `POINT (1 1)`.
- `LINESTRING (0 0, 4 0)` → `POINT (2 0)`.

## Limitations

- On lon/lat the centroid is computed in degrees, which is fine at small scales.

## Credits

`ST_Centroid` (DuckDB spatial). Modelled on the WhiteboxTools tool of the same purpose (MIT).

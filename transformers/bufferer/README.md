# Bufferer

Buffers every feature by a distance in metres, in a projection chosen per feature.

## What it does

The distance is in metres, so the geometry leaves longitude/latitude before `ST_Buffer` touches it
— a degree of longitude is 111 km at the equator and 39 km in the Arctic.

| Coordinate system | |
|---|---|
| azimuthal_equidistant (default) | a projection centred on each feature's own centroid; distances from the centre are true anywhere |
| individual_utm | the UTM zone of the centroid (326xx north, 327xx south); accurate inside a zone |
| same_as_feature | no reprojection: the distance is in the stream's own units — degrees on lon/lat |

A projected stream is taken to lon/lat for the per-feature projections and brought back afterwards.

## When to use it

- A 1 km zone around every mill.
- A 500 m buffer around plots anywhere in the world.

## When not to use it

- The smallest enclosing circle — **MinimumBoundingCircle**.
- Simplifying outlines — **SimplifyFeatures**.

## Parameters

| Parameter | |
|---|---|
| Distance (m) | metres for the per-feature projections; the stream's units for same_as_feature |
| Coordinate system | see the table above |

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced by its buffer |

## Examples

- A point at 8.5°E 47.4°N, 1000 m, azimuthal_equidistant → a 32-sided polygon of about 1 km radius.
- The same buffer at the equator and at 69°N has the same area under azimuthal_equidistant.

## Limitations

- `ST_Buffer` draws a 32-sided polygon, so a circle's area comes out about 0.6% smaller.
- A wide polygon straddling UTM zones is distorted on its far side under individual_utm.

## Credits

DuckDB spatial (`ST_Buffer`, `ST_Transform` with PROJ).

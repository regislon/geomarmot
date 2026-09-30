# Reprojector

Moves geometry from the stream's coordinate system into another one.

## What it does

Every geometry is transformed from the stream's CRS into the destination, and the stream is
relabelled, so the nodes below know where it is: the map brings it back to lon/lat to draw,
measurements enter their equal-area projection from it, writers record it, and the H3 nodes refuse
it. The destination is anything PROJ accepts, tried once when the graph is built. Axis order is
always x then y (`always_xy`), so EPSG:4326's latitude-first definition never swaps coordinates.

## When to use it

- Export in Swiss LV95 (`EPSG:2056`).
- Bring a projected stream back to lon/lat.

## When not to use it

- Correct coordinates with a wrong label — **CoordinateSystemSetter**.
- A file with a wrong CRS — the **Reader**'s override.

## Parameters

| Parameter | |
|---|---|
| Destination CRS | an EPSG or ESRI code, or a PROJ string |

## Output ports

| Port | |
|---|---|
| Output | the rows with geometry in the destination CRS |

## Examples

- Bern at 7.43863°E 46.95108°N → `POINT (2600000 1200000)` in EPSG:2056.
- A stream labelled EPSG:2056 → back to `EPSG:4326`.

## Limitations

- The destination equal to the stream's own CRS passes rows through unchanged.

## Credits

PROJ, through DuckDB spatial.

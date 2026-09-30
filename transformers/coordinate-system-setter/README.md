# CoordinateSystemSetter

Labels the stream with a coordinate system without changing any coordinates.

## What it does

The coordinate system belongs to the stream, so every node below takes the new label: the map
reprojects from it to draw, a Reprojector reprojects from it, measurements enter their equal-area
projection from it, and the writers name it. Nothing is moved. The name is checked against PROJ when
the graph is built, so a typo stops here rather than at the map.

## When to use it

- Points made from Swiss E/N columns: VertexCreator → CoordinateSystemSetter `EPSG:2056` →
  Reprojector `EPSG:4326`.
- A stream that a node labelled wrongly.

## When not to use it

- Moving coordinates — **Reprojector**.
- A file whose CRS is missing or wrong — the **Reader**'s CRS override, at the source.

## Parameters

| Parameter | |
|---|---|
| Coordinate System | an EPSG or ESRI code, or a PROJ string |

## Output ports

| Port | |
|---|---|
| Output | the same rows, labelled |

## Examples

- Points at (2600000 1200000) with `EPSG:2056` → unchanged coordinates, stream now LV95.

## Limitations

- One CRS per stream, not per feature.
- The choice is not checked against the data.

## Credits

PROJ, through DuckDB spatial.

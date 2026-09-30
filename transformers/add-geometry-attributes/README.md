# AddGeometryAttributes

Adds measurements of each shape as attributes.

## What it does

| Measure | Attribute | |
|---|---|---|
| Area (ha) | `area_ha` | in an equal-area projection (EPSG:6933) |
| Perimeter (km) | `perimeter_km` | same projection |
| Vertices | `vertices` | point count |
| Geometry type | `geometry_type` | POINT, POLYGON, … |
| Parts | `parts` | 1 unless multi-part |
| Centroid lon/lat | `centroid_lon`, `centroid_lat` | in longitude/latitude |

Area and perimeter are entered into EPSG:6933 from the stream's actual CRS — within about 0.7%
anywhere. The spheroid functions are not used: on this engine `ST_Area_Spheroid` reports the same
area for a 1° square at every latitude, nearly three times too large in the Arctic.

## When to use it

- Each plot's area in hectares.
- Flag multi-part features by their part count.
- Centroid coordinates for a spreadsheet.

## When not to use it

- Keeping only features above an area — **FilterVectorFeaturesByArea**.

## Parameters

| Parameter | |
|---|---|
| Add | which measures to add |

## Output ports

| Port | |
|---|---|
| Output | the rows with the measures added |

## Examples

- A 0.01° square at 10°N → `area_ha` ≈ 121, `perimeter_km` ≈ 4.4, `geometry_type` POLYGON.
- A 100 m square in EPSG:2056 → `area_ha` = 1, measured from LV95.

## Limitations

- EPSG:6933's ±0.7% error is fine for hectares, not for survey-grade areas.

## Credits

DuckDB spatial with PROJ. Modelled on the WhiteboxTools tool of the same purpose (MIT).

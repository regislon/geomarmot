# FilterVectorFeaturesByArea

Keeps features whose area lies between two bounds in hectares.

## What it does

Each feature's area is measured in hectares in an equal-area projection (EPSG:6933), entered from
the stream's actual CRS. Features with `min ≤ area ≤ max` go to **Kept**, the rest to **Removed**.
A blank maximum means no upper limit.

## When to use it

- Drop slivers smaller than half a hectare.
- Keep plots between 1 and 5 hectares.

## When not to use it

- Any other attribute — **Tester**.
- Adding the area as a column — **AddGeometryAttributes**.

## Parameters

| Parameter | |
|---|---|
| Minimum area (ha) | default 0 |
| Maximum area (ha) | blank = no limit |

## Output ports

| Port | |
|---|---|
| Kept | features within the bounds |
| Removed | the others |

## Examples

- Squares of about 121 ha and 484 ha with bounds 100–300 → Kept: the first; Removed: the second.

## Limitations

- Points and lines measure 0 ha.

## Credits

DuckDB spatial with PROJ. Modelled on the WhiteboxTools tool of the same purpose (MIT).

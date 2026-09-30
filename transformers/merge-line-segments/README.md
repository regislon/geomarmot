# MergeLineSegments

Joins line segments that share endpoints into longer lines.

## What it does

Within each feature, segments that meet end to end become one line; a fully connected feature becomes one LINESTRING, disconnected pieces stay parts of a MULTILINESTRING. Non-line geometries pass through. Attributes ride along; null geometries stay null.

## When to use it

- Tidy a road digitised as many segments; one line per route before measuring.

## When not to use it

- Lines from different rows on their own — a **Dissolver** first, then this.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced |

## Examples

- `MULTILINESTRING ((0 0, 1 0), (1 0, 2 1), (5 5, 6 6))` → `MULTILINESTRING ((0 0, 1 0, 2 1), (5 5, 6 6))`.

## Limitations

- Works within one feature only.

## Credits

`ST_LineMerge` (DuckDB spatial, GEOS). Modelled on the WhiteboxTools tool of the same purpose (MIT).

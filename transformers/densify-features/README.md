# DensifyFeatures

Adds vertices so that no segment is longer than the tolerance.

## What it does

Every segment longer than the tolerance gets evenly spaced vertices. The shape does not change — a
densified polygon keeps its area — but it bends correctly when reprojected afterwards, which
matters for long straight edges. The tolerance is in the stream's own units.

## When to use it

- Before reprojecting large rectangles so their edges curve.
- Give long straight segments intermediate vertices.

## When not to use it

- Removing vertices — **SimplifyFeatures**.

## Parameters

| Parameter | |
|---|---|
| Max segment (degrees) | the longest segment allowed, above zero |

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry densified |

## Examples

- `LINESTRING (0 0, 2 0)` with 0.5 → `LINESTRING (0 0, 0.5 0, 1 0, 1.5 0, 2 0)`.

## Limitations

- Runs on the main thread, one feature at a time.

## Credits

JSTS `Densifier`. Modelled on the WhiteboxTools tool of the same purpose (MIT).

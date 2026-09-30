# SmoothVectors

Rounds off corners by Chaikin subdivision; each pass doubles the vertices.

## What it does

Every pass replaces each corner by two points a quarter of the way along its two segments, so the
outline becomes smoother and the vertex count doubles. The shape shrinks slightly each pass, since
corners are cut; a line keeps its end points. Computed in JavaScript.

## When to use it

- Soften jagged digitised boundaries.
- Round a generalised outline for display.

## When not to use it

- Removing detail — **SimplifyFeatures**.
- More vertices without changing the shape — **DensifyFeatures**.

## Parameters

| Parameter | |
|---|---|
| Passes | 1 to 4; each doubles the vertices |

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry smoothed |

## Examples

- `LINESTRING (0 0, 2 0, 2 2)`, one pass → `LINESTRING (0 0, 1.5 0, 2 0.5, 2 2)`.

## Limitations

- Polygons shrink slightly with each pass.

## Credits

Chaikin's algorithm, implemented here on JSTS geometries. Modelled on the WhiteboxTools tool of the
same purpose (MIT).

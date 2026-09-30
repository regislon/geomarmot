# MinimumBoundingCircle

The smallest circle enclosing each feature, as a polygon.

## What it does

Every geometry is replaced by the smallest circle that contains it, as a polygon the map and the
writers can use. The circle is computed in the stream's own coordinates: on lon/lat it is round in
degrees, not on the ground.

## When to use it

- The reach of each set of sites around its centre.
- Compare how compact shapes are.

## When not to use it

- A zone at a fixed distance — **Bufferer**.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced by its circle |

## Examples

- A 2×2 square → a circle of radius √2 around (1 1).

## Limitations

- Round in the stream's units only; reproject to a metric CRS for a true circle.

## Credits

JSTS `MinimumBoundingCircle`. Modelled on the WhiteboxTools tool of the same purpose (MIT).

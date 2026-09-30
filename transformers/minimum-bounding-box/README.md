# MinimumBoundingBox

The smallest rectangle around each feature, at any angle — not axis-aligned.

## What it does

Every geometry is replaced by the minimum-area rectangle containing it, rotated to fit. A square
tilted by 45° comes back as itself, where its axis-aligned envelope would be half as large again.
Computed in JavaScript with JSTS (DuckDB has no such function); rows are materialised with an id so
each result joins back to its own row.

## When to use it

- The orientation and size of each parcel.
- A tight rectangle around a diagonal feature.

## When not to use it

- An axis-aligned box with its bounds — **BoundingBoxReplacer**.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the rows with each geometry replaced by its rectangle |

## Examples

- `POLYGON ((2 0, 4 2, 2 4, 0 2, 2 0))` → the same square (area 8, where the envelope's is 16).

## Limitations

- Runs on the main thread, one feature at a time.

## Credits

JSTS `MinimumDiameter`. Modelled on the WhiteboxTools tool of the same purpose (MIT).

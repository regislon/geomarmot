# AttributeHistogram

Bins an attribute's values into equal-width bins and counts each bin.

## What it does

The range from minimum to maximum is split into equal-width bins; each non-empty bin becomes a row
with `bin` (from 0), `bin_start`, `bin_end` and `n`. The maximum is pulled into the top bin, so the
counts add up to the rows with a value. NULLs are left out; a single distinct value makes one bin.

## When to use it

- See how areas are distributed.
- Choose classification thresholds.

## When not to use it

- Category counts — **ListUniqueValues**.

## Parameters

| Parameter | |
|---|---|
| Attribute | the numeric attribute |
| Bins | how many equal-width bins; default 20 |

## Output ports

| Port | |
|---|---|
| Output | one row per non-empty bin |

## Examples

- 0, 1, 2, 3, 4, 8 with 4 bins (width 2) → bin 0: 2, bin 1: 2, bin 2: 1, bin 3: 1.

## Limitations

- Empty bins are not listed.

## Credits

DuckDB windows and `GROUP BY`. Modelled on the WhiteboxTools tool of the same purpose (MIT).

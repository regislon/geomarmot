# AttributeCorrelation

Pearson correlation between every pair of chosen numeric attributes.

## What it does

One row per unordered pair: `attribute_a`, `attribute_b`, `r` (Pearson's coefficient) and `n`
(rows), strongest first by |r|, undefined correlations last. One row per pair says everything once,
unlike a matrix, and can be sorted and exported.

## When to use it

- Find which measurements move together.
- Check two attributes for redundancy.

## When not to use it

- One attribute's distribution — **AttributeHistogram**.

## Parameters

| Parameter | |
|---|---|
| Attributes | at least two numeric attributes |

## Output ports

| Port | |
|---|---|
| Output | one row per pair |

## Examples

- `a` = 1, 2, 3, 4, `b` = 2a, `c` unrelated → (a, b) with r = 1 first.

## Limitations

- Linear association only; rows with a NULL in either attribute are skipped by `corr`.

## Credits

DuckDB `corr`. Modelled on the WhiteboxTools tool of the same purpose (MIT).

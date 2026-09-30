# ListUniqueValues

One row per distinct value of an attribute, with its count and share.

## What it does

Output rows are `value`, `n` (rows with it) and `percent` (share of all rows, two decimals), most
frequent first, ties in value order. NULL counts as a value.

## When to use it

- See the categories of a column before filtering.
- Check a column for unexpected values.

## When not to use it

- A numeric distribution — **AttributeHistogram**.
- Counts with other aggregates — **Aggregator**.

## Parameters

| Parameter | |
|---|---|
| Attribute | the attribute to list |

## Output ports

| Port | |
|---|---|
| Output | one row per value |

## Examples

- `cat` = a, b, a, NULL, c → `a 2 40`, then `b`, `c` and NULL at `1 20`.

## Limitations

- Replaces the input rows; use it on a branch.

## Credits

DuckDB `GROUP BY` and a window. Modelled on the WhiteboxTools tool of the same purpose (MIT).

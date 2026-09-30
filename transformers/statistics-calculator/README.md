# StatisticsCalculator

Statistics of numeric attributes per group — as a summary, or attached to every row.

## What it does

For each chosen numeric attribute and each group, the ticked statistics: Minimum, Maximum, Sum,
Mean, Median, Range, Standard deviation (sample), Standard deviation (population), Mode, Total count
(rows), Numeric count (rows with a value), Value count (distinct values). Results are named
`attribute_statistic` (`v_mean`, `v_standard_deviation`).

- **Summary**: one row per group.
- **Complete**: every input row with its group's statistics attached (a window function, not a join).

Without attributes, it counts rows.

## When to use it

- Mean and spread of plot areas per region.
- Attach each group's total to every row to compute shares.

## When not to use it

- Named counts and sums, or a dissolved shape — **Aggregator**.
- A distribution in bins — **AttributeHistogram**.

## Parameters

| Parameter | |
|---|---|
| Group by | attributes defining a group; empty = the whole input |
| Attributes | numeric attributes only |
| Statistics | which statistics to compute for each attribute |

## Output ports

| Port | |
|---|---|
| Summary | one row per group |
| Complete | every row plus its group's statistics |

## Examples

- Group by `cat`, attribute `v`, every statistic → per category: `v_sum`, `v_mean`, `v_minimum`, …

## Limitations

- Sample standard deviation is NULL for a group of one row.

## Credits

DuckDB aggregate and window functions.

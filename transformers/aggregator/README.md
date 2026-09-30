# Aggregator

Groups rows and computes aggregates per group; optionally dissolves each group's geometry.

## What it does

Rows sharing the **Group by** values become one row, carrying those values and the aggregates you
ask for:

| Function | |
|---|---|
| count | rows (or, with an attribute, rows where it has a value) |
| sum, min, max, mean, median | of the attribute |
| count distinct | distinct values of the attribute |

Each aggregate can be named; the default is `func_attribute` (`sum_v`). With no aggregates the node
counts rows per group. **Geometry**: *Drop* (default) outputs a plain table; *Dissolve* merges each
group's shapes with `ST_Union_Agg`, joining touching polygons into one ring.

## When to use it

- Count plots per category; sum field areas per farm.
- One dissolved shape per region, with its totals.

## When not to use it

- Statistics attached back to every row — **StatisticsCalculator** (Complete port).
- Merging shapes when the shape is the point — **Dissolver**.

## Parameters

| Parameter | |
|---|---|
| Group by | attributes defining a group; empty = the whole input is one group |
| Aggregates | function · attribute · optional name |
| Geometry | **Drop** or **Dissolve** |

## Output ports

| Port | |
|---|---|
| Output | one row per group |

## Examples

- Group by `cat`: count, sum of `v`, mean of `v` as `avg_v`, min, max, median, count distinct of
  `name` → one row per category.
- Dissolve three unit squares by `cat` → two touching `farm` squares become one 2×1 rectangle.

## Limitations

- Aggregates over text other than count and count distinct fail when read; pick numeric columns.

## Credits

DuckDB aggregates; `ST_Union_Agg` from DuckDB spatial.

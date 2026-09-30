# SQLTransformer

Any DuckDB SELECT over the incoming rows, which the query reads as `input`.

## What it does

The query's result is the output — any columns, any number of rows. The incoming stream is the
table `input`. Your own CTEs (`WITH …`, `WITH RECURSIVE`) are merged with the binding for `input`
rather than nested, so AI-written SQL that opens with `WITH` works as written. An empty query passes
rows through; a trailing semicolon is tolerated.

SQL here is **restricted**: it may only read `input` (and its own CTEs), with no table functions,
file reads or settings (docs/security.md). Allowing unrestricted SQL is an explicit choice in the
inspector.

## When to use it

- Count rows per category in one line.
- A window function, a pivot, a spatial predicate.
- A query an assistant wrote against this node's schema.

## When not to use it

- Only adding columns — **AttributeCreator** checks the query really adds one.
- A simple filter — **Tester** shows both outputs.

## Parameters

| Parameter | |
|---|---|
| Query | a single SELECT reading `input` |

## Output ports

| Port | |
|---|---|
| Output | whatever the query returns |

## Examples

- `SELECT cat, count(*) AS n FROM input GROUP BY cat` → one row per category.
- `WITH big AS (SELECT * FROM input WHERE v > 5) SELECT id FROM big`.

## Limitations

- One input; combine streams first with FeatureJoiner or Unioner.
- This engine is DuckDB 1.1.1: `SELECT * RENAME` does not parse.

## Credits

DuckDB SQL.

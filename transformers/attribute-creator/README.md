# AttributeCreator

Adds attributes to every row — from a builder, or from a DuckDB SELECT.

## What it does

**Builder** mode: each new attribute is a name and a value. The value is one of

| Kind | |
|---|---|
| Value | a constant of a chosen type — Text keeps `01234` as text, Number, Boolean, or Null |
| Attribute | a copy of another attribute |
| Formula | two operands (each an attribute or a constant) with `+ − × ÷` or *join text*; `÷` by zero gives NULL rather than an error |
| SQL | any DuckDB expression over the row's attributes |

**SQL query** mode: the whole SELECT, with the incoming rows as the table `input`. Keep `input.*`
so the existing attributes survive, and add columns beside it. Your own CTEs (`WITH …`, including
`WITH RECURSIVE`) are merged with the binding for `input` rather than nested, so AI-written SQL
that opens with `WITH` works as written.

SQL is checked as you type and again when the graph is built. A query that does not compile, is not
a single SELECT, or adds no attribute stops at this node. The schema panel lists the input's columns
— with the values of categorical ones — and **Copy for AI** puts that and the syntax rules on the
clipboard.

SQL here is **restricted**: it may read only `input` (docs/security.md). Unrestricted SQL is an
explicit choice in the inspector.

## When to use it

- Add a computed column: `area_ha`, a label, a copy of another attribute.
- Make geometry from columns: `ST_Point(lon, lat)` or `ST_GeomFromText(wkt)`.
- Paste a SELECT an assistant wrote against this node's schema.

## When not to use it

- Points from coordinate columns in a known CRS — **VertexCreator** also labels the stream.
- Renaming or removing attributes — **AttributeRenamer**, **AttributeRemover**, or
  **AttributeManager** for many edits.
- A query that changes the rows (filters, groups, joins) — **SQLTransformer**.

## Parameters

| Parameter | |
|---|---|
| How | **Builder** or **SQL query**. |
| New attributes | Builder: one row per new attribute, a name and a value. |
| Query | SQL query: a single SELECT over `input` that keeps `input.*` and adds at least one column. |

## Output ports

| Port | |
|---|---|
| Output | Every input row with the new attributes. |

## Examples

- Builder: `double_v` = Formula `v × 2`; `zip` = Value (Text) `01234` → `zip` stays `01234`.
- SQL query: `SELECT input.*, v * 2 AS v2 FROM input`.
- Builder: `pt` = SQL `ST_Point(id, id)` on a table with no geometry → a point per row, on the map.

## Limitations

- On this engine (DuckDB 1.1.1), `SELECT * RENAME` is a parser error; the syntax reference behind
  the `?` lists what works.
- Area: use an equal-area projection, not `ST_Area_Spheroid`, which is wrong away from the equator
  on this build (the syntax reference shows the expression).
- Categorical values in the schema panel come from the first 20,000 rows.

## Credits

DuckDB SQL.

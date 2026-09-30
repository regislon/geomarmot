# DuplicateFilter

Keeps the first row for each key; the others come out of **Duplicate**.

## What it does

Rows are grouped by the key attributes you choose. One row per key leaves through **Unique**;
every further row with the same key leaves through **Duplicate**, so nothing is lost. Geometry can
be part of the key — DuckDB compares geometries directly, so "same shape" is a duplicate test like
any other. With no key, every row is unique.

## When to use it

- Drop repeated rows before a join.
- Keep one feature per identical geometry.
- Find ids that appear more than once (the Duplicate port).

## When not to use it

- Points that are only nearly in the same place — **EliminateCoincidentPoints**.
- Combining the duplicates' values — **Aggregator**.

## Parameters

| Parameter | |
|---|---|
| Key attributes | The attributes that together identify a duplicate; geometry allowed. |

## Output ports

| Port | |
|---|---|
| Unique | The first row for each key. |
| Duplicate | Every further row with a key already seen. |

## Examples

- Rows `(1, x)`, `(1, x)`, `(2, y)`, `(3, y)` keyed on `id, k` → Unique: 3 rows; Duplicate: one
  `(1, x)`.

## Limitations

- When duplicates differ in attributes outside the key, which one is "first" is not guaranteed.

## Credits

A DuckDB window function (`row_number()` per key).

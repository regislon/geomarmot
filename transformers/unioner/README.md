# Unioner

Stacks two streams into one; columns are matched by **name**.

## What it does

The **Bottom** rows are appended under the **Top** rows (`UNION ALL BY NAME`). A column that only
one side has is kept, with NULL for the other side's rows; the same attributes in a different order
line up. Repeated rows are kept.

## When to use it

- Stack two tiles of the same layer.
- Append this year's table to last year's.

## When not to use it

- Matching rows on a key — **FeatureJoiner**.
- Removing repeats afterwards — follow with **DuplicateFilter**.

## Parameters

None.

## Output ports

| Port | |
|---|---|
| Output | the Top rows followed by the Bottom rows |

## Examples

- Top `(id, name)` and Bottom `(name, id, extra)` → `id, name, extra`, with `extra` NULL for the
  top rows.

## Limitations

- Both inputs must be in the same coordinate system; the node refuses otherwise.
- A column with the same name but incompatible types on the two sides is an error.

## Credits

DuckDB `UNION ALL BY NAME`.

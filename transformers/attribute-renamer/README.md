# AttributeRenamer

Renames attributes; values and column order stay as they were.

## What it does

Each rename row maps an existing attribute to a new name. The renamed column stays where it was,
with the same values. The node writes every column out by name, because this engine's SQL has no
`* RENAME` shorthand. A row with only one side filled in is ignored until both are.

## When to use it

- Rename `E`/`N` to `x`/`y` before sharing a file.
- Give spreadsheet columns clean names.
- Match the names another tool expects.

## When not to use it

- To keep the old name as well — **AttributeManager**'s *Copy to*.
- To change values — **AttributeCreator** or **AttributeManager**.

## Parameters

| Parameter | |
|---|---|
| Renames | Pairs of existing attribute → new name. |

## Output ports

| Port | |
|---|---|
| Output | The same rows with the attributes renamed in place. |

## Examples

- `id, name, cat` with `name → full_name` → `id, full_name, cat`.
- Names with spaces or quotes (`odd "name"`) are renamed like any other.

## Limitations

- Renaming to a name another column already has is an error at that node: a table cannot hold two
  columns of the same name.

## Credits

A single DuckDB SELECT.

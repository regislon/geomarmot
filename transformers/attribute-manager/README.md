# AttributeManager

Sets, renames, copies, creates and removes attributes — in order, in one node.

## What it does

A list of edits, applied top to bottom:

| Edit | |
|---|---|
| Set value | overwrite an attribute with a value |
| Rename | give an attribute a new name |
| Copy to | duplicate an attribute under a new name |
| Create | add a new attribute with a value |
| Remove | drop an attribute |

Values use the same builder as AttributeCreator: a constant, an attribute, a formula or SQL. Order is
kept — each edit is its own nested SELECT — because renaming a column and then setting the new name
is a different result from the reverse. An edit that is not filled in, or names an attribute that is
not there (yet), is skipped.

## When to use it

- A dozen small edits that are one step in your head.
- Rename a column, then set its values.
- Copy an attribute before overwriting it.

## When not to use it

- One kind of edit on a few columns: **AttributeKeeper**, **AttributeRemover** and
  **AttributeRenamer** read better on the canvas.
- A computed column from a full SELECT: **AttributeCreator** in SQL mode.

## Parameters

| Parameter | |
|---|---|
| Edits | The edits, top to bottom; each sees the attributes as the edits above left them. |

## Output ports

| Port | |
|---|---|
| Output | The rows after every edit. |

## Examples

- Set `v` = 0, rename `name` → `who`, copy `who` → `who_copy`, create `twice` = `id × 2`,
  remove `cat`.
- Rename `v` → `w`, then set `w` = SQL `id * 100` → `w` holds `id * 100`.

## Limitations

- SQL values are restricted to the row's attributes (docs/security.md).

## Credits

DuckDB SQL.

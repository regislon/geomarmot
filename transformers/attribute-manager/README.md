# AttributeManager

Sets, renames, copies, creates, converts and removes attributes — in order, in one node.

## What it does

A list of edits, applied top to bottom:

| Edit | |
|---|---|
| Set value | overwrite an attribute with a value |
| Rename | give an attribute a new name |
| Copy to | duplicate an attribute under a new name |
| Create | add a new attribute with a value |
| Convert | change an attribute's type: Text, Integer, Decimal, Boolean, Date, Date and time; a value that does not convert becomes empty |
| Remove | drop an attribute |

Values use the same builder as AttributeCreator: a constant, an attribute, a formula or SQL. Order is
kept — each edit is its own nested SELECT — because renaming a column and then setting the new name
is a different result from the reverse. An edit that is not filled in, or names an attribute that is
not there (yet), is skipped. A renamed attribute keeps its place among the others.

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
| Edits | The edits, top to bottom; each sees the attributes as the edits above left them. Edited as a table (below); the assistant writes the list directly. |

**Edit attributes…** opens a table with one row per input attribute: *Input attribute*, *Output
attribute*, *Value*, *Type*, *Action*. Every row starts as *Do nothing*. Typing a new output name
renames the attribute, *set a value* gives it a new value, the *Type* column converts it to another
type, and *Remove* drops it. Geometry and nested values keep their type. **+ Add attribute**
adds a row that creates a new attribute, or copies an existing one when you pick it as the input.
Nothing changes until **OK**.

The table saves the edits in a fixed order: copies, values, new attributes, conversions, renames,
then removals.
Values therefore read the input's attributes under their input names. If a list was written in
another order, for example by the assistant, the table says so before OK rewrites it.

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

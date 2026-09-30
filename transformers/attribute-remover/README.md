# AttributeRemover

Drops the attributes you list and keeps all the others, in their order.

## What it does

The listed attributes are taken out of every row; every other column passes through in its
original order. Removing the geometry column turns a layer into a plain table. With nothing
listed, nothing is removed.

## When to use it

- Drop working columns before exporting.
- Remove the geometry to get a table for a spreadsheet.
- Tidy a wide table where only a few columns are unwanted.

## When not to use it

- To keep a few columns of a wide table — **AttributeKeeper** names only what stays.

## Parameters

| Parameter | |
|---|---|
| Attributes to remove | The attributes to drop from every row. |

## Output ports

| Port | |
|---|---|
| Output | The same rows without the listed attributes. |

## Examples

- `id, name, cat, v, geometry` with **Attributes to remove** = `cat, v` → `id, name, geometry`.

## Limitations

- Removing an attribute that is not in the input is an error at that node, naming the column.

## Credits

A single DuckDB SELECT with `* EXCLUDE`.

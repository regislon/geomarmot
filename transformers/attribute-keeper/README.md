# AttributeKeeper

Keeps only the attributes you list, in the order you list them.

## What it does

Every row keeps the listed attributes and loses all the others. The kept columns come out in the
order of the list, so the node also reorders columns. The geometry column is an attribute like any
other. With nothing listed, rows pass through unchanged.

## When to use it

- Keep only the columns a recipient needs before a Writer.
- Put columns in a fixed order.
- Keep just the geometry (or just the attributes) of a layer.

## When not to use it

- To drop a few columns from a wide table — **AttributeRemover** names only what goes.
- To rename columns — **AttributeRenamer**.

## Parameters

| Parameter | |
|---|---|
| Attributes to keep | The attributes to keep, in output order. Everything else is dropped. |

## Output ports

| Port | |
|---|---|
| Output | The same rows with only the listed attributes. |

## Examples

- `id, name, cat, v, geometry` with **Attributes to keep** = `name, id` → `name, id`.
- With **Attributes to keep** = `geometry, cat` → a layer with just a category and its shapes.

## Limitations

- Listing an attribute that is not in the input is an error at that node, naming the column.

## Credits

A single DuckDB SELECT.

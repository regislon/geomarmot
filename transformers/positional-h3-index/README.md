# PositionalH3Index

Derives each row's H3 index from its position in a dense positional tile.

## What it does

A **dense positional tile** is a Parquet file named after its parent cell
(`866500cdfffffff.parquet`, optionally with a numeric prefix) holding all 7ⁿ children of that
cell in ascending order, with no cell column: row *i* is child *i*. This node turns the Reader's
`file_row_number` back into an `h3_index` column.

The index is arithmetic, not a lookup: H3's sorted child order is base-7 counting over the index's
3-bit digit fields, so child *i* is the parent with its resolution set and its digits replaced by
*i*'s base-7 digits. It is lazy and free, even on the 823,543 rows of a resolution-6 tile.

## When to use it

- Give a dense tile an `h3_index` column.
- Index a tile before joining it to other H3 data.
- See a tile on the map: the map draws an `h3_index` column directly.

## When not to use it

- Hexagon geometry as well — **H3GeometryFromPosition**.
- Files that already have an index column — **H3GeometryFromIndex**.

## Parameters

| Parameter | |
|---|---|
| Parent cell | blank: taken from the file name |
| Child resolution | blank: derived from the row count |

## Output ports

| Port | |
|---|---|
| Output | the rows with `h3_index` instead of `file_row_number` |

## Examples

- `891f8d7a49bffff.parquet` with 7 rows and Row number Auto → the 7 resolution-10 children, in order.

## Limitations

- Needs the Reader's **Row number** (Auto does it for a dense tile; Parquet only).
- A pentagon parent is refused: its children skip a subsequence and are not in base-7 order.
- A row count that is not a whole number of children is refused.
- Longitude/latitude streams only.

## Credits

H3 by Uber (Apache-2.0); the index arithmetic is checked cell for cell against h3-js.

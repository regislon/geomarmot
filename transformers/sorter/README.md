# Sorter

Orders rows by one or more attributes, each ascending or descending.

## What it does

The first sort key decides; each later key breaks ties in the one before. NULLs sort last. The
order is what the attribute grid shows and what a Writer writes.

## When to use it

- Order a table by name before exporting it.
- Show the largest areas first.
- Order by category, then by id within each category.

## When not to use it

- Keeping only the top N rows on its own — follow the Sorter with a **Sampler** (First N).

## Parameters

| Parameter | |
|---|---|
| Sort by | attributes, most important first, each ASC or DESC |

## Output ports

| Port | |
|---|---|
| Output | the same rows, in order |

## Examples

- `cat` DESC then `id` ASC on five rows → `c` first, then the two `b`/`a` groups by id, NULL last.

## Limitations

- Transformers after a Sorter are not promised to keep its order; sort last, just before a Writer.

## Credits

DuckDB `ORDER BY`.

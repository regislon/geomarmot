# Sampler

Takes a subset of rows: the first N, every Nth, or a random percentage.

## What it does

| How | |
|---|---|
| First N | the first N rows in scan order |
| Every Nth | one row in N |
| Random % | each row kept independently with that chance (Bernoulli), so the count varies run to run |

An amount that is not a positive number passes every row through.

## When to use it

- Try a slow chain on the first 1,000 rows of a big file.
- A random 10% for a quick look.
- Thin a dense point layer.

## When not to use it

- The rows with the largest values — sort with a **Sorter** first.
- Sampling H3 cells by position — the H3 geometry nodes sample on their own.

## Parameters

| Parameter | |
|---|---|
| How | **First N**, **Every Nth** or **Random %** |
| N (or percent) | rows, stride or percent |

## Output ports

| Port | |
|---|---|
| Output | the sampled rows |

## Examples

- Rows 1–5, Every Nth with N = 2 → rows 2 and 4.
- 50 rows, Random 50% → about 25 rows, a different set each run.

## Limitations

- Scan order is fine for a sample but not for anything positional.

## Credits

DuckDB `LIMIT`, `row_number()` and `USING SAMPLE … (bernoulli)`.

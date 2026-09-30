# Tester

Splits rows into **Passed** and **Failed** by a set of conditions.

## What it does

Each condition is an attribute, an operator and (for most operators) a value:

| Operator | Passes when |
|---|---|
| `=`, `!=`, `>`, `>=`, `<`, `<=` | the comparison holds, in the column's own type |
| contains | the text contains the value |
| starts with | the text begins with the value |
| is null, is not null | the attribute is (not) empty |

Conditions combine with **AND** (all must hold) or **OR** (any may). A row whose test cannot be
decided — its attribute is NULL — goes to **Failed**, so the two ports always add up to the input.
The value field suggests what is in the column: its values for text, its minimum, quartiles and
maximum for numbers. With no conditions, every row passes.

## When to use it

- Keep the cities with more than 50,000 people.
- Separate rows with a missing category.
- Find names that start with a prefix.

## When not to use it

- One output per category value — **AttributeFilter**.
- Several rules where the first match wins — **TestFilter**.
- An area threshold in hectares — **FilterVectorFeaturesByArea**, which measures correctly.

## Parameters

| Parameter | |
|---|---|
| Combine with | **AND** or **OR**. |
| Conditions | attribute · operator · value, one row each. |

## Output ports

| Port | |
|---|---|
| Passed | Rows for which the test is true. |
| Failed | Rows for which it is false or undecidable (NULL). |

## Examples

- `cat = a` AND `v > 5` on five rows → Passed: row 1 (`a`, 10.5); Failed: the rest, including
  row 3 (`a` with no `v`).
- `name = O'Neil` → quotes in values are handled.

## Limitations

- Values are typed as text and cast by DuckDB to the column's type; a value that cannot be cast
  (letters against a number column) is an error at this node.

## Credits

A DuckDB WHERE clause, wrapped so NULL counts as not passing.

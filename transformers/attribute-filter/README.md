# AttributeFilter

Routes rows to **one output port per value** of an attribute, and the rest to Unfiltered.

## What it does

Choose an attribute and list values. Each value gets its own output port on the canvas; rows whose
attribute equals it come out there. Rows with any other value, or no value, come out of
**Unfiltered**. Values are compared exactly, as text. At most 40 values get ports: past that, rows
fall through to Unfiltered, so a high-cardinality column cannot freeze the canvas.

## When to use it

- Send farms, mills and forests down separate branches.
- Split a layer by country code.

## When not to use it

- Ranges or patterns — **Tester** or **TestFilter**.
- Just counting values — **ListUniqueValues**.

## Parameters

| Parameter | |
|---|---|
| Attribute | The attribute whose value decides the port. |
| Values | The values that get their own ports. |

## Output ports

| Port | |
|---|---|
| one per value | Rows whose attribute equals that value. |
| &lt;Unfiltered&gt; | Everything else, NULLs included. |

## Examples

- `cat` with values `a`, `b` on rows `a, b, a, NULL, c` → `a`: 2 rows, `b`: 1 row, Unfiltered:
  the `NULL` and the `c` rows.

## Limitations

- Exact matches only; case and spacing count.
- Ports are numbered by position, so reordering the values reconnects the links by position.

## Credits

One DuckDB SELECT per port.

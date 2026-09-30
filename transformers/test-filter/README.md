# TestFilter

Routes each row to the **first rule** it satisfies, or to Unfiltered.

## What it does

An ordered list of rules, each with a label, an attribute, an operator and a value, and each with
its own output port. A row goes to the first rule it satisfies; a row claimed by an earlier rule is
never offered to a later one, so the ports partition the input. Rows that satisfy no rule come out
of **Unfiltered**. A rule that is not filled in matches nothing. The operators are the Tester's.

## When to use it

- Classify a value into bands — big, medium, small — in one node.
- Route by the first of several conditions in priority order.

## When not to use it

- One port per exact value — **AttributeFilter**.
- A single pass/fail — **Tester**.

## Parameters

| Parameter | |
|---|---|
| Rules, in order | label · attribute · operator · value; the first satisfied rule wins. |

## Output ports

| Port | |
|---|---|
| one per rule | Rows satisfying that rule and none above it. |
| &lt;Unfiltered&gt; | Rows satisfying no rule. |

## Examples

- `big: v > 5`, then `a: cat = a` → the `a` row with `v = 10.5` goes to `big` only; the `a` row
  with no `v` goes to `a`.

## Limitations

- One condition per rule; put a Tester upstream to combine conditions.
- At most 40 rules get ports.

## Credits

One DuckDB SELECT per port, each excluding the rules above it.

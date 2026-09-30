# FeatureJoiner

Joins two streams on matching attributes; unmatched rows get their own ports.

## What it does

Rows of **Left** and **Right** are matched on one or more attribute pairs (`left.id = right.key`).
**Joined** holds the combined rows; **Unjoined L** and **Unjoined R** hold the rows of each side
that found no partner. The join type decides what Joined holds:

| Join | Joined |
|---|---|
| Inner | matched rows only |
| Left | every left row; right attributes NULL where nothing matched |
| Full | every row of both sides |

The right side's join keys are dropped (they equal the left ones). Any other right attribute whose
name the left already has gets the suffix (`area` → `area_right`), so no two columns share a name.

## When to use it

- Attach an owner table to plots by plot id.
- Find the plots with no owner (**Unjoined L**).

## When not to use it

- Stacking two streams — **Unioner**.
- Joining by location — a spatial predicate in an **SQLTransformer**.

## Parameters

| Parameter | |
|---|---|
| Join | **Inner**, **Left** or **Full**. |
| Join on | pairs of left and right attributes that must be equal. |
| Suffix for clashing right attributes | appended to a right name the left already has; default `_right`. |

## Output ports

| Port | |
|---|---|
| Joined | the joined rows, per the join type |
| Unjoined L | left rows with no match |
| Unjoined R | right rows with no match |

## Examples

- Left ids 1, 2, 3 and right keys 1, 3, 4, Inner on `id = key` → Joined: 1 and 3 (with
  `area_right`); Unjoined L: 2; Unjoined R: 4.

## Limitations

- Keys compare with SQL equality: a NULL key matches nothing.
- It joins on attributes only; there is no spatial join.
- In a **Full** join, a right row with no partner has NULL join keys in Joined, because the right
  side's keys are dropped; **Unjoined R** still has them.

## Credits

DuckDB joins.

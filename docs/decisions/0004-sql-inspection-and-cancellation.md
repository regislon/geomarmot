# 0004 — SQL inspection with `json_serialize_sql`; cancel, then restart

**Status:** accepted (gate S4)

## Findings

| # | Criterion | Result |
|---|---|---|
| G1 | `json_serialize_sql()` exposes statement type, base tables (replacement scans included, as `BASE_TABLE` with a file-like name), table functions (`TABLE_FUNCTION`), functions in expressions, subqueries, set operations and CTE names | **pass**; anything but a SELECT is refused with an error, which the guard treats as a rejection |
| G2 | `cancelSent()` stops a runaway query within 1 s and leaves the connection usable | **partial**: scans, aggregates, sorts, buffers, recursive CTEs and `ST_Intersects` joins stop in 15–350 ms; nested-loop joins (`ST_DWithin` joins, cross products with arithmetic predicates) ignore it, and `cancelSent()` itself does not return |
| G3 | autoload/autoinstall can be switched off after boot | **pass**, provided `spatial`, `parquet` and `json` are loaded explicitly first |
| G4 | DDL is transactional | **pass**: `BEGIN; CREATE VIEW …; CREATE VIEW …; ROLLBACK` leaves nothing, also when the second view fails |
| G5 | several connections work at once | **pass**: DDL in two transactions and parser calls on a third interleave without interference |

Terminating the DuckDB worker and booting a fresh instance takes about 0.9 s.

## Decision

- The SQL guard (`app/src/core/sqlguard/`) works on the tree from `json_serialize_sql`, on its own
  parser connection.
- **Cancel, then restart.** A watchdog first calls `cancelSent()`. If the query has not stopped
  within 2 s, the engine is restarted: the worker is terminated, a new instance booted, and every
  source re-registered automatically. Registered files keep their bytes or URL in the source
  registry; snapshot sources (Zarr arrays, Excel sheets) keep a Parquet copy in memory, so they are
  restored without reading the original again. The graph is then recompiled.
- AI previews run in their own, separate DuckDB instance on materialised samples, which can always
  be terminated without affecting the user's graph.

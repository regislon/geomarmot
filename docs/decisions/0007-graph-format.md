# 0007 — Saved-graph format and compatibility

**Status:** accepted

- A saved graph is `{ "format": "geomarmot-graph", "version": 1, "nodes": [], "edges": [], "custom": [] }`,
  validated against `schemas/graph.schema.json`.
- GeoMarmot does not read graphs saved by the application it was derived from.
- Transformer ids are stable from the first release. A later rename is declared in the
  registry's `aliases`; a change to a parameter's shape is a `migrations` step on the transformer.
  Both are tested.

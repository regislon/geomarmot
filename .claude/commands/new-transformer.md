---
description: Add a transformer, fixtures first
argument-hint: <TransformerName>
---

Add the transformer `$ARGUMENTS` to GeoMarmot. Follow AGENTS.md; in order:

1. Read `docs/transformer-api.md`, `docs/params.md`, `docs/engines.md` and one of the
   `examples/` transformers closest to what you need.
2. Walk the ladder in `docs/code-economy.md`: search `transformers/` and `transformers/_kit/`
   for an existing transformer or helper that already does this, or most of it. If a chain of
   existing transformers covers it, say so and stop.
3. `npm run new-transformer -- $ARGUMENTS` to scaffold the folder.
4. Write `transformers/<id>/tests.json` **first**: normal cases, edge cases (empty input, NULLs,
   empty geometries), every output port including rejected ones, one case per main option.
5. Implement `index.js` against the contract (pure SQL first; `prepare` only when DuckDB cannot
   do it). Run `npm run test:browser -- transformers` until the fixtures pass.
6. Fill in every description field and the README headings.
7. Run `npm run check`, then `/ponytail-review` (or the manual checklist), and note any
   shortcut in `docs/debt.md`.

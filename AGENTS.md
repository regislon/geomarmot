# AGENTS.md — the brief for coding agents

GeoMarmot is a spatial ETL workbench that runs in the browser. DuckDB-Wasm does the work in the
user's tab; a graph of transformers compiles to one DuckDB view per output port, so nothing is
computed until something reads it. This file is the one source of truth for agents (Claude Code,
Codex, Cursor, …). `CLAUDE.md` only points here.

## Where things live

| Path | What |
|---|---|
| `app/src/core/` | no DOM: DuckDB boot and queries (`duck.js`), graph model and compiler, schema/CRS helpers, the SQL guard |
| `app/src/io/` | readers and writers, one module per format; remote URL handling |
| `app/src/engines/` | JavaScript geometry work DuckDB cannot do (JSTS, h3-js) |
| `app/src/ui/` | canvas, inspector, table, map, modals |
| `app/src/ai/` | the in-app assistant: providers, tools, privacy gate, generated transformers |
| `transformers/<id>/` | **one folder per transformer**: `index.js`, `README.md`, `tests.json` |
| `transformers/_kit/` | the public transformer API: `defineTransformer`, `param.*`, helpers |
| `server/` | optional local server (Python package `geomarmot`): static files, bucket proxy, AI relay |
| `tests/` | harness, contract, I/O, e2e, terms; `transformers/*/tests.json` are fixtures |
| `docs/` | architecture, transformer API, params, engines, formats, security, decisions |

## Golden rules

1. **Tests are the specification.** For a transformer, write `tests.json` first, then the code.
   A change is done when the fixtures pass on the app's own engine.
2. **Run `npm run check` before every commit** (lint, types, unit tests, forbidden terms, file
   size, docs, fixtures). Run `npm run test:browser` when you touch app, transformer or I/O code.
3. **Small, local files.** No maintained source file over 400 lines. One transformer per folder.
4. **Code economy.** Before writing code, walk the ladder in `docs/code-economy.md`: does it need
   to exist, is it already in the codebase, the standard library, the platform, or an installed
   dependency? Record deliberate shortcuts in `docs/debt.md`. Fixture, documentation and safety
   rules always win over code economy.
5. **Descriptions are part of the contract.** Every transformer's `summary`, `description`,
   `whenToUse`, `whenNotToUse`, `keywords`, param and port descriptions and README headings are
   checked by `npm run check:docs`.
6. **SQL safety.** Parameter values reach SQL only through the kit's quoting and splice helpers.
   SQL written by users or the assistant is checked by the SQL guard before DuckDB sees it.
   Never add a path that executes such SQL without the guard.
7. **The assistant never writes JavaScript that runs in the page.** Generated transformers are
   declarative specs (SQL templates and calls to reviewed transformers).

## Never

- mention the organisation this code came from, its people, buckets or repositories, or any
  commercial ETL product (the `check:terms` gate enforces this, including commit messages);
- commit binary fixtures (generate them in `tests/fixtures/build.js`);
- load code from a CDN at runtime (everything is bundled; see `docs/decisions/0002`);
- store API keys anywhere but the browser's session/local storage, or put them in URLs, saved
  graphs, exports or logs;
- weaken a test to make it pass.

## Commands

```bash
npm run dev             # Vite dev server
npm run check           # everything that needs no browser
npm run test:browser    # fixtures, contract, I/O and e2e in Chromium
npm run new-transformer -- MyThing   # scaffold a transformer folder
cd server && uv run pytest           # server tests
```

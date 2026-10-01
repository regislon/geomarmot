# Contributing

**All contributions are welcome.** A new transformer, a fix, a test case that shows a bug, a
better description, a documentation page, a bug report, an idea in an issue — every one of them
makes GeoMarmot better, whether you have been doing spatial ETL for twenty years or this is your
first pull request. You can write the code yourself or with a coding agent: GeoMarmot is built to be
changed by people and agents alike, the rules are written down ([AGENTS.md](AGENTS.md)), and the
checks enforce them.

Not sure where to start? Open an issue describing what you would like to do, and we will help you
find the right place.

## Set up

You need Node 22, [uv](https://docs.astral.sh/uv/) for the server, and GDAL's `ogr2ogr` (the
`gdal-bin` package, or `brew install gdal`) for the GeoPackage and FlatGeobuf test fixtures.

```bash
npm ci
npx playwright install chromium
uv sync --project server
npm run dev
```

`npm ci` also points git at `.githooks/`, whose pre-commit hook runs the forbidden-terms gate on
what you are about to commit.

## Checks

| Command | What |
|---|---|
| `npm run check` | lint, types, unit tests, imports, generated schemas, forbidden terms, file sizes, transformer docs and fixtures. Needs no browser; run it before every commit. |
| `npm run test:browser` | builds the app and the test build, then every browser suite: fixtures, contract, compiler lifecycle, SQL guard, I/O, e2e, privacy, offline. Run it when you touch app, transformer or I/O code. |
| `cd server && uv run pytest` | the server, with `uv run ruff check .` and `uv run ruff format --check .` |
| `npm run eval` | the assistant against a real model (needs `ANTHROPIC_API_KEY`, costs tokens; see [evals/](evals/README.md)) |

CI runs the same jobs and all of them must pass.

## Add a transformer in 10 minutes

A transformer is a folder with three files. The fixtures are its specification: write them first.

**1. Scaffold it.**

```bash
npm run new-transformer -- KeepFirstRows --group Reshape
```

This creates `transformers/keep-first-rows/` with `index.js`, `README.md` and `tests.json` from
templates, and adds the import to `transformers/index.js`. The templates contain guidance comments
that `npm run check:docs` refuses, so nothing half-written can be committed.

**2. Write `tests.json`.** One case per behaviour: typed input tables, the params, and what each
output port must hold. The format is in [docs/params.md](docs/params.md).

```json
{
  "transformer": "KeepFirstRows",
  "cases": [
    {
      "name": "keeps the first two rows in input order",
      "params": { "count": "2" },
      "inputs": {
        "input": {
          "crs": "EPSG:4326",
          "columns": [{ "name": "id", "type": "INTEGER" }],
          "rows": [[1], [2], [3]]
        }
      },
      "ordered": true,
      "expect": { "output": { "columns": [{ "name": "id", "type": "INTEGER" }], "rows": [[1], [2]] } }
    }
  ]
}
```

**3. Implement `index.js`** with the kit — `defineTransformer`, `param.*`, and one SELECT per
output port. Values reach SQL only through `qid`, `qlit` and the kit's helpers; SQL written by a
user is spliced only with `spliceQuery` or `spliceExpression`. Hooks that need to run SQL use
`ctx.engine`. [docs/transformer-api.md](docs/transformer-api.md) is the contract;
[`examples/`](examples) has three reference transformers (pure SQL, SQL with `prepare`, a `crs`
hook).

```js
sql: (ctx) => ({
  output: `SELECT * FROM ${ctx.inputs.input} LIMIT ${Math.max(0, Math.floor(Number(ctx.params.count) || 0))}`,
}),
```

**4. Run its fixtures.**

```bash
npm run build:test
npx playwright test tests/browser/fixtures.spec.js -g KeepFirstRows
```

For a case whose output is tedious to write by hand, `node scripts/capture-expectations.js --only
KeepFirstRows` fills in `expect` from what the engine produced. Read what it wrote before you commit
it: a captured expectation is a claim that the behaviour is right.

**5. Document it.** Fill in the metadata (`summary`, a `description` of at least 60 words,
`whenToUse`, `whenNotToUse` naming the transformer to use instead, `keywords`, `examples`, a
description for every param, option and port) and the README's headings. Users read this in the
`?` panel, and the assistant reads it to decide what to use.

**6. Check and commit.**

```bash
npm run check && npm run test:browser
```

`npm run check:schemas` will tell you to run `npm run build:schemas`: the generated params schema
includes your transformer.

## Code economy

Before writing code, walk the ladder in [docs/code-economy.md](docs/code-economy.md): does it need to
exist; is it already in the codebase, the standard library, DuckDB, the platform, or an installed
dependency? Record deliberate shortcuts in [docs/debt.md](docs/debt.md). Fixture, documentation and
safety rules always win over fewer lines. The pull request template asks for the answers.

With Claude Code, the [ponytail](https://github.com/dietrichgebert/ponytail) plugin is configured in
`.claude/settings.json`: `/ponytail-review` before a pull request answers most of the checklist.

## Rules that are enforced

- **No maintained source file over 400 lines** (`npm run check:size`).
- **No references to the organisation this project came from, its people, buckets or repositories,
  or to commercial ETL products**, in files, paths or commit messages (`npm run check:terms`, the
  pre-commit hook, and CI over every commit).
- **No binary fixtures**: generate them in `tests/fixtures/build.js`.
- **Nothing from a CDN at runtime**: dependencies are bundled, DuckDB extensions are served with the
  app.
- **No new path that runs user or assistant SQL without the SQL guard** ([docs/security.md](docs/security.md)).
- **Never weaken a test to make it pass.**

## Pull requests

Every pull request is read by a maintainer. It is accepted when:

1. **CI passes**: the `check`, `browser` and `server` jobs (and `package`, when it runs). Run
   `npm run check` and `npm run test:browser` before you push to save a round trip.
2. **The behaviour is tested.** A new or changed transformer comes with `tests.json` cases written
   first; other changes come with a unit, I/O or end-to-end test. A bug fix comes with the test
   that failed before it.
3. **A human has read the fixtures.** Captured expectations are claims about behaviour; say in the
   pull request that you checked them.
4. **It is documented.** Transformer metadata and READMEs pass `npm run check:docs`; user-visible
   changes update the relevant page under `docs/`.
5. **It keeps the safety rules.** No SQL path around the SQL guard, nothing sent to a model around
   the privacy gate, no hook that reaches the main engine directly ([security](docs/security.md)).
6. **It is small and on one subject**, and the code-economy questions in the template are answered.
   Large changes are easier to accept after a short issue agreeing on the approach.
7. **It can be released under the project's licence**: you wrote it (yourself or with an agent),
   or it comes from a compatible open-source licence that you name, and it is contributed under
   Apache-2.0.

Fill in the template: what changes, that a human has read the fixtures, the code-economy answers,
and which agent (if any) wrote it. If something is missing, the review will say what and help you
get there — a pull request that is not ready yet is still welcome.

Be kind in issues and reviews; see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

Set the same version in `package.json`, `server/pyproject.toml` and `server/geomarmot/__init__.py`,
commit, and push a tag `v<version>`. The release workflow checks that the tag and the versions
agree, runs every CI and package job again, then publishes the wheel and sdist to PyPI, the image to
GHCR, the static app to GitHub Pages, and a GitHub release.

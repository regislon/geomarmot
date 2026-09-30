# GeoMarmot

> Spatial ETL in your browser. Wire transformers on a canvas and let the marmot tunnel through your
> Parquet, GeoPackage and Excel. Your data never leaves the burrow.

GeoMarmot is a browser-native spatial ETL workbench. DuckDB-Wasm does the work in your own tab:
dropped files are never uploaded, and remote files are read with HTTP range requests.

**Status:** under construction. See [PLAN.md](PLAN.md) for where it is going.

## Develop

```bash
npm install
npm run dev
```

`npm run check` runs lint, type checks, unit tests and the repository gates.
`npm run test:browser` runs the browser suites (fixtures, contract, e2e).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

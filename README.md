# GeoMarmot

> Spatial ETL in your browser. Wire transformers on a canvas and let the marmot tunnel through your
> Parquet, GeoPackage and Excel. Your data never leaves the burrow.

GeoMarmot is a browser-native spatial ETL workbench. DuckDB-Wasm does the work in your own tab:
dropped files are never uploaded, and remote files are read with HTTP range requests, so opening a
large remote Parquet costs its footer, not its body.

![The workbench: a graph on the canvas, its rows in the table, its points on the map](docs/img/workbench.png)

- **44 transformers** — attributes, filters, joins and overlays, reshaping, geometry, analysis and
  H3 — each one a DuckDB view per output port, so nothing is computed until you look at it.
- **Reads** Parquet and GeoParquet, CSV and TSV (also gzipped), GeoPackage, GeoJSON, FlatGeobuf,
  Excel and Zarr; from your disk, a URL, or a `gs://` bucket through the local server.
- **Writes** Parquet, GeoParquet, GeoJSON, CSV and Excel.
- **Coordinate systems** are tracked through the graph; the map draws lon/lat and anything PROJ can
  bring back to it.
- **Works offline** once installed: every dependency and DuckDB extension ships with the app.
- **An optional assistant** builds graphs from a request, with Claude or OpenAI models. It proposes
  a draft you preview and apply; you choose what it may see of your data, and by default that is
  column names and types only ([security](docs/security.md)).

![The assistant proposing a draft: points from Swiss coordinates](docs/img/assistant.png)

## Run it

GeoMarmot is not published as a package. There are two ways to use it.

### 1. In your browser, at the hosted link

Open **<https://regislon.github.io/geomarmot/>**. Nothing to install: the app runs entirely in your
tab, and the files you open stay on your machine. The hosted copy has no server behind it, so
`gs://` buckets and the bucket browser are not available there; the assistant works with an API key
you type into its settings.

### 2. From a clone of the repository

You need Node 22 and, for the local server, [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/regislon/geomarmot.git
cd geomarmot
npm ci
npm run build
cd server && uv run geomarmot    # opens http://127.0.0.1:8765 in your browser
```

The local server adds what a browser cannot do alone: reading `gs://` buckets with your own cloud
credentials, browsing buckets, and letting the assistant use a key from your environment
(`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) instead of one typed into the page. It only listens on
127.0.0.1 and refuses any other Host: remote access is not supported.

To build and run it as a container instead:

```bash
docker build -t geomarmot .
docker run --rm -p 127.0.0.1:8080:8080 geomarmot
```

Open the link the container prints.

## Develop

```bash
npm ci
npm run dev                # Vite on http://localhost:5173
npm run check              # lint, types, unit tests and the repository gates
npm run test:browser       # every browser suite, in Chromium
```

Adding a transformer takes three files and about ten minutes: see [CONTRIBUTING.md](CONTRIBUTING.md).
Coding agents start from [AGENTS.md](AGENTS.md).

| | |
|---|---|
| [Architecture](docs/architecture.md) | how a file becomes a view, generations and leases, the assistant |
| [Transformer API](docs/transformer-api.md) and [params](docs/params.md) | the contract every transformer follows |
| [Engines](docs/engines.md) | DuckDB-Wasm, GDAL, JSTS, h3-js, zarrita, SheetJS — and their limits |
| [Formats](docs/formats.md) | what reads and writes what, and how |
| [Security and privacy](docs/security.md) | the local server, the SQL boundary, the assistant's data levels |
| [Parity](docs/parity.md), [decisions](docs/decisions/), [debt](docs/debt.md) | what was kept, what was decided, what is left |

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

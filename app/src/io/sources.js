/*
 * Where data comes from: dropped files and pasted URLs.
 *
 * A dropped file is read into memory once and registered as a buffer — it never
 * leaves the browser. A URL is registered for range reads instead, so opening a
 * remote parquet costs its footer rather than its whole body.
 */

import { dropFile, registerBuffer, registerUrl, query, qid, qlit } from "../core/duck.js";
import { describeH3Source } from "../engines/h3.js";
import { dropTable, materialize } from "./zarr.js";
import { closeWorkbook, materializeSheet, previewSheet, readWorkbook } from "./xlsx.js";
import { hideProgress, readWithProgress, showProgress } from "../ui/progress.js";
import { describe, findGeometryColumn, readGeoMetadata, crsFromGeoMetadata } from "../core/schema.js";

/** id -> source record. */
export const sources = new Map();

let _sourceCounter = 0;

const GCS_HOST = "storage.googleapis.com";

/**
 * Formats read through GDAL rather than DuckDB's own parquet reader.
 *
 * duckdb-wasm's spatial extension turns out to ship GDAL — `st_drivers()`
 * reports 45 of them — so GeoPackage, GeoJSON and FlatGeobuf come for free,
 * from a dropped buffer or over HTTP range reads. Shapefile is deliberately
 * absent: it needs its .shx/.dbf siblings, which a single dropped file cannot
 * carry.
 *
 * `.json` is in the list because a great many GeoJSON files are named that
 * way — ArcGIS, Overpass and most REST APIs all emit `.json` — and being told
 * the format is unsupported when the file is plainly GeoJSON is a poor answer.
 * The cost is that a `.json` holding something else now fails inside GDAL
 * rather than at the extension check, so `ogrOpenError` says so in those terms.
 */
const OGR_EXTENSIONS = /\.(gpkg|geojson|json|fgb)$/i;
const PARQUET_EXTENSIONS = /\.(parquet|pq)$/i;
/*
 * Delimited text, read by DuckDB's own sniffer.
 *
 * `read_csv` with no options detects the delimiter, the quoting, the line
 * ending and the column types, so a semicolon-separated European export and a
 * tab-separated dump both open without a dialect to configure. `.gz` is in the
 * pattern because DuckDB decompresses transparently.
 *
 * A CSV carries no geometry: a WKT column stays VARCHAR and lon/lat stay
 * numbers. Building a geometry from them is an AttributeCreator away
 * (`ST_Point("lon", "lat")`, or `ST_GeomFromText("wkt")`), and the map picks
 * that up like any other geometry — so the Reader deliberately does not guess.
 */
const CSV_EXTENSIONS = /\.(csv|tsv)(\.gz)?$/i;
/*
 * Excel workbooks, parsed in JS (see xlsx.js) because neither DuckDB's excel
 * extension nor GDAL's XLSX driver can read one in the browser. `.xlsm` is the
 * same format with macros, which are ignored.
 */
const XLSX_EXTENSIONS = /\.(xlsx|xlsm)$/i;

/** Which reader a file goes through, decided by name alone. */
function formatFor(displayName) {
  if (OGR_EXTENSIONS.test(displayName)) return "ogr";
  if (CSV_EXTENSIONS.test(displayName)) return "csv";
  if (XLSX_EXTENSIONS.test(displayName)) return "xlsx";
  return "parquet";
}

/** The FROM clause for a source, whatever its format. */
export function sourceRelation(source, { rowNumber = false } = {}) {
  // A Zarr layer or a workbook sheet was read and flattened when it was added:
  // there is no file to point at, only the table the cells landed in.
  if (source.table) {
    return qid(source.table);
  }
  if (source.format === "ogr") {
    const layer = source.layer ? `, layer=${qlit(source.layer)}` : "";
    return `st_read(${qlit(source.fileName)}${layer})`;
  }
  if (source.format === "csv") {
    return `read_csv(${qlit(source.fileName)})`;
  }
  // file_row_number is a parquet reader option; nothing else offers it.
  return rowNumber
    ? `read_parquet(${qlit(source.fileName)}, file_row_number=true)`
    : `read_parquet(${qlit(source.fileName)})`;
}

/**
 * Turn whatever the user pasted into a URL the browser can actually read.
 *
 * Cloud-storage forms are rewritten onto the local server's /proxy/gs route:
 * most buckets send no CORS headers, so a direct fetch fails in the browser no
 * matter how public the object is. Anything else is passed through untouched and succeeds or fails on
 * the remote host's own CORS policy.
 */
export function resolveUrl(input) {
  const text = input.trim();
  // Relative to the page, never rooted at "/", so the app keeps working when it
  // is served under a path prefix.
  const proxy = (path) => new URL(path, window.location.href).href;

  // A gs:// path is written the way gsutil prints it — unescaped — so its
  // segments have to be encoded. Without this, a key holding a "#" or "?" is
  // silently truncated at that character, and one holding a space produces a
  // URL the proxy cannot forward.
  if (text.startsWith("gs://")) {
    const path = text.slice("gs://".length).split("/").map(encodeURIComponent).join("/");
    return proxy(`proxy/gs/${path}`);
  }
  try {
    const url = new URL(text);
    if (url.hostname === GCS_HOST) {
      return proxy(`proxy/gs${url.pathname}`);
    }
    if (url.hostname.endsWith(`.${GCS_HOST}`)) {
      const bucket = url.hostname.slice(0, -(GCS_HOST.length + 1));
      return proxy(`proxy/gs/${bucket}${url.pathname}`);
    }
    return url.href;
  } catch {
    throw new Error(`"${text}" is not a URL or a gs:// path.`);
  }
}

/** Unique logical name for DuckDB, so two files called data.parquet can coexist. */
function logicalName(displayName) {
  _sourceCounter += 1;
  return `s${_sourceCounter}__${displayName.replace(/[^\w.-]/g, "_")}`;
}

async function introspect(source) {
  const from = sourceRelation(source);
  source.columns = await describe(`SELECT * FROM ${from}`);
  source.geometry = findGeometryColumn(source.columns);
  const rows = await query(`SELECT count(*) AS n FROM ${from}`);
  source.rows = Number(rows[0]?.n ?? 0);

  if (source.format === "ogr") {
    // GDAL already told us the CRS when the layers were listed, and it is
    // authoritative in a way the parquet `geo` block is not.
    source.crs = source.crs || { code: "EPSG:4326", assumed: true };
    return source;
  }
  if (source.geometry) {
    source.crs = crsFromGeoMetadata(await readGeoMetadata(source.fileName));
    return source;
  }
  // No geometry of its own — but a file named after an H3 cell carries its
  // geometry implicitly, in its name and its row order.
  source.h3 = describeH3Source(source.name, source.columns, source.rows);
  // Row order is only recoverable from parquet, so an H3-named CSV can still be
  // used through an index column but never positionally.
  if (source.format !== "parquet" && source.h3?.mode === "positional") {
    source.h3 = { ...source.h3, mode: "none", note: "row order is only readable from parquet" };
  }
  if (source.h3 && source.h3.mode !== "none") {
    source.crs = { code: "EPSG:4326", assumed: false };
  }
  return source;
}

/** CRS of a layer as GDAL reports it, which beats guessing from a WKT string. */
function crsFromOgrLayer(layer) {
  const crs = layer?.geometry_fields?.[0]?.crs;
  if (crs?.auth_name && crs?.auth_code) {
    return { code: `${crs.auth_name}:${crs.auth_code}`, assumed: false };
  }
  return { code: crs?.name || "unknown", assumed: !crs };
}

/**
 * Split an OGR file into one source per layer.
 *
 * A GeoPackage is a container, and its layers are what people actually think
 * of as datasets — so each becomes its own row in the Layers rail rather than
 * hiding behind a picker on the Reader.
 */
async function ogrLayerSources(base) {
  let layers = [];
  try {
    const meta = await query(`SELECT layers FROM st_read_meta(${qlit(base.fileName)})`);
    layers = meta[0]?.layers || [];
  } catch (err) {
    console.warn(`Could not list layers in ${base.name}`, err);
  }
  if (layers.length <= 1) {
    const only = layers[0];
    const source = { ...base, layer: only?.name || null, crs: crsFromOgrLayer(only) };
    await introspect(source);
    sources.set(source.id, source);
    return [source];
  }

  const made = [];
  for (const layer of layers) {
    const source = {
      ...base,
      id: `${base.id}#${layer.name}`,
      name: `${base.name} › ${layer.name}`,
      layer: layer.name,
      crs: crsFromOgrLayer(layer),
    };
    await introspect(source);
    sources.set(source.id, source);
    made.push(source);
  }
  return made;
}

/*
 * Report a failed OGR open in terms of the format the name promised.
 *
 * Only `.json` needs the translation: it is the one extension the app accepts
 * on spec rather than on evidence, so the file that lands here is as likely to
 * be a config file or a saved graph as a broken GeoJSON, and GDAL's own
 * wording explains neither.
 */
function ogrOpenError(base, err) {
  if (!/\.json$/i.test(base.name)) return err;
  // GDAL quotes the registered name, which carries the uniquifying prefix and
  // reads like a second, unfamiliar file in the same sentence.
  const detail = (err?.message || String(err)).split(base.fileName).join(base.name);
  return new Error(`${base.name} is not GeoJSON — GDAL could not read it (${detail})`);
}

function blankSource(fileName, displayName, origin, extra = {}) {
  return {
    id: fileName,
    name: displayName,
    fileName,
    origin,
    format: formatFor(displayName),
    layer: null,
    sizeBytes: null,
    columns: [],
    geometry: null,
    crs: null,
    h3: null,
    rows: 0,
    ...extra,
  };
}

/** Distinct table per workbook sheet, so two workbooks with a "Sheet1" can coexist. */
let _sheetCounter = 0;

/**
 * Split a workbook into one source per non-empty sheet.
 *
 * Like a GeoPackage's layers, a workbook's sheets are what people think of as
 * its datasets, so each gets its own row in the Layers rail. Unlike them, a
 * sheet cannot be read in place: the workbook is a zip of XML with no way to
 * reach one sheet's rows without parsing it, so each is built into a table on
 * open, and a remote workbook is fetched whole rather than range-read.
 *
 * Which is why `chooseSheets` exists. It is asked which sheets to open and
 * where each one's column names are — reports put titles above their tables,
 * so the first row is often not the header. It gets the file name, every
 * sheet's summary and a `preview(name)` for the header-row step, and returns
 * `[{name, headerRow}]`, or null to open nothing. Without it, every sheet with
 * rows is opened with its first non-blank row as the header.
 */
async function xlsxSheetSources(displayName, bytes, origin, extra = {}, chooseSheets = null) {
  showProgress(`Parsing ${displayName}…`);
  const { book, sheets } = await readWorkbook(bytes).catch((err) => {
    hideProgress();
    throw err;
  });
  try {
    let wanted = sheets.filter((sheet) => !sheet.empty).map((sheet) => ({ name: sheet.name, headerRow: null }));
    if (!wanted.length) throw new Error(`${displayName} has no rows in any sheet.`);
    if (chooseSheets) {
      // The bar would sit over the picker saying "parsing" while it waits on a click.
      hideProgress();
      wanted = await chooseSheets(displayName, sheets, (name) => previewSheet(book, name));
      if (!wanted?.length) return [];
    }
    const made = [];
    for (const [index, { name: sheet, headerRow }] of wanted.entries()) {
      const label = wanted.length > 1 ? `Opening ${sheet} (${index + 1} of ${wanted.length})` : `Opening ${sheet}`;
      showProgress(`${label}…`, index / wanted.length);
      _sheetCounter += 1;
      const table = `xlsx_${_sheetCounter}`;
      const built = await materializeSheet(book, sheet, table, {
        headerRow,
        onProgress: ({ stage, done, total }) => {
          if (stage === "rows") {
            showProgress(`${label} — reading cells…`, null);
            return;
          }
          const fraction = (index + (total ? done / total : 1)) / wanted.length;
          showProgress(`${label} — ${done.toLocaleString()} of ${total.toLocaleString()} rows`, fraction);
        },
      });
      if (!built) continue;
      const source = blankSource(table, displayName, origin, {
        ...extra,
        table,
        name: sheets.length > 1 ? `${displayName} \u203a ${sheet}` : displayName,
        layer: sheet,
        headerRow,
      });
      await introspect(source);
      sources.set(source.id, source);
      made.push(source);
    }
    // A sheet whose declared range was only formatting has no rows to build.
    if (!made.length) throw new Error(`${displayName}: the chosen sheets have no rows.`);
    return made;
  } finally {
    hideProgress();
    await closeWorkbook(book);
  }
}

/**
 * Returns the sources the file produced — more than one for a multi-layer
 * container, none when a workbook's sheet picker was dismissed.
 */
export async function addLocalFile(file, { chooseSheets = null } = {}) {
  if (XLSX_EXTENSIONS.test(file.name)) {
    const bytes = await file.arrayBuffer();
    return xlsxSheetSources(file.name, bytes, "local", { sizeBytes: file.size }, chooseSheets);
  }
  const fileName = logicalName(file.name);
  await registerBuffer(fileName, new Uint8Array(await file.arrayBuffer()));
  const base = blankSource(fileName, file.name, "local", { sizeBytes: file.size });
  if (base.format === "ogr") {
    return ogrLayerSources(base).catch((err) => {
      throw ogrOpenError(base, err);
    });
  }
  await introspect(base);
  sources.set(base.id, base);
  return [base];
}

export async function addRemoteFile(input, { chooseSheets = null } = {}) {
  const url = resolveUrl(input);
  const displayName = decodeURIComponent(url.split("/").pop() || "remote.parquet");
  if (XLSX_EXTENSIONS.test(displayName)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    let bytes;
    try {
      bytes = await readWithProgress(response, `Downloading ${displayName}`);
    } catch (err) {
      hideProgress();
      throw err;
    }
    const sizeBytes = bytes.byteLength;
    return xlsxSheetSources(displayName, bytes, "url", { url, sizeBytes }, chooseSheets);
  }
  const fileName = logicalName(displayName);
  await registerUrl(fileName, url);
  const base = blankSource(fileName, displayName, "url", { url });
  // GDAL reads a remote container through the same range requests DuckDB uses,
  // so a GeoPackage behind a URL needs no special handling.
  if (base.format === "ogr") {
    return ogrLayerSources(base).catch((err) => {
      throw ogrOpenError(base, err);
    });
  }
  await introspect(base);
  sources.set(base.id, base);
  return [base];
}

/** Distinct table per Zarr layer, so two arrays of one store can both be open. */
let _zarrCounter = 0;

/**
 * Add a Zarr layer: read the plan's cells into a table, then register that.
 *
 * This is the one source that costs real work to open — the others register a
 * file and read a footer. A plan is checked and priced in the picker before it
 * gets here (see zarr.js), so what arrives is something the user has agreed to
 * pay for.
 */
export async function addZarrLayer({ store, variable, plan, georeference }) {
  _zarrCounter += 1;
  const table = `zarr_${_zarrCounter}`;
  const built = await materialize(store, variable, plan, georeference, table);
  const source = {
    id: table,
    name: `${store.name} \u203a ${variable.name}`,
    // Stands in for the registered file name: it is what sourceRelation reads
    // and what the "is this file still in use" check compares.
    fileName: table,
    table,
    origin: "zarr",
    format: "zarr",
    layer: variable.name,
    sizeBytes: null,
    columns: built.columns,
    geometry: built.geometry,
    // No geo-reference means no geometry, and a CRS on a table of array indexes
    // would be a claim about where they are that nothing supports.
    crs: built.geometry ? georeference.crs || { code: "EPSG:4326", assumed: true } : null,
    h3: null,
    rows: built.rows,
    zarr: { url: store.url, variable: variable.name, plan },
  };
  sources.set(source.id, source);
  return [source];
}

/**
 * Forget a source, and unregister its file once nothing else needs it.
 *
 * The check matters for containers: a multi-layer GeoPackage is several sources
 * over one registered file, and dropping the file while another layer still
 * points at it would break that layer instead.
 */
export async function removeSource(id) {
  const source = sources.get(id);
  if (!source) return;
  sources.delete(id);
  if (source.table) {
    await dropTable(source.table);
    return;
  }
  const stillUsed = [...sources.values()].some((other) => other.fileName === source.fileName);
  if (!stillUsed) await dropFile(source.fileName);
}

/**
 * Formats the app can open directly.
 *
 * Shapefile is missing on purpose: GDAL can read one, but only with its
 * .shx/.dbf siblings alongside, and a single dropped file cannot bring them.
 */
export function isSupportedFile(file) {
  return isSupportedName(file.name);
}

/** The same test by name, for things that are not File objects — bucket keys. */
export function isSupportedName(name) {
  return (
    PARQUET_EXTENSIONS.test(name) ||
    OGR_EXTENSIONS.test(name) ||
    CSV_EXTENSIONS.test(name) ||
    XLSX_EXTENSIONS.test(name)
  );
}

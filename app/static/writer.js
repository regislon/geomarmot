/*
 * Export.
 *
 * Parquet and CSV are a plain COPY, GeoJSON is assembled in SQL because the
 * GDAL writer does not work here, and Excel is built by SheetJS in a worker. GeoParquet is the awkward one: whether
 * duckdb-wasm's spatial build writes the `geo` metadata block is not something
 * to take on faith, so this writes the file and then reads its own footer back
 * to find out. If the block is there, the file ships as real GeoParquet. If it
 * is not, the geometry goes out as WKB with a sidecar and the caller is told
 * plainly which of the two it got — an almost-GeoParquet presented as the real
 * thing is worse than an honest pair of files.
 */

import { copyToBuffer, db, exec, query, qid, qlit } from "./duck.js";
import { H3_INDEX_COLUMN, MAX_MATERIALISED_CELLS, createCellGeometryTable } from "./h3.js";
import { findGeometryColumn, geometryExpression, describe, isLonLatCode, LONLAT } from "./schema.js";
import { hideProgress, showProgress } from "./progress.js";
import { MAX_EXCEL_COLUMNS, MAX_EXCEL_ROWS, writeWorkbook } from "./xlsx.js";

let _exportCounter = 0;

/**
 * Ceiling on hexagons built for one export — the same sanity limit the H3
 * nodes use. Past it the export still happens, just with the index column and
 * no geometry, and says so.
 */
const MAX_H3_EXPORT_CELLS = MAX_MATERIALISED_CELLS;

/**
 * Materialise hexagon geometry for a view whose geometry lives in its H3 index.
 *
 * This is what makes "export every cell" work while the map still draws only a
 * few thousand: the display limit and the export are independent.
 */
async function materialiseH3Geometry(viewName, tag) {
  const cells = await query(
    `SELECT DISTINCT ${qid(H3_INDEX_COLUMN)} AS cell FROM ${viewName}
     WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL LIMIT ${MAX_H3_EXPORT_CELLS + 1}`,
  );
  if (cells.length > MAX_H3_EXPORT_CELLS) return null;

  // The same chunked builder the H3 nodes use, so a full tile exports rather
  // than blowing up on one enormous buffer.
  const tableName = `h3cells_export_${tag}`;
  await createCellGeometryTable(
    cells.map((row) => row.cell),
    tableName,
  );

  const joined = `h3joined_${tag}`;
  await exec(
    `CREATE OR REPLACE VIEW ${joined} AS
     SELECT v.*, c.geometry FROM ${viewName} v
     LEFT JOIN ${tableName} c ON v.${qid(H3_INDEX_COLUMN)} = c.cell`,
  );
  return { view: joined, cells: cells.length, cleanup: [`DROP VIEW IF EXISTS ${joined}`, `DROP TABLE IF EXISTS ${tableName}`] };
}

/** Unique name in the WASM filesystem, so a double-click cannot race itself. */
function virtualName(extension) {
  _exportCounter += 1;
  return `export_${_exportCounter}.${extension}`;
}

function download(bytes, fileName, mimeType) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportParquet(viewName, baseName) {
  const virtual = virtualName("parquet");
  const bytes = await copyToBuffer(
    `COPY (SELECT * FROM ${viewName}) TO ${qlit(virtual)} (FORMAT PARQUET)`,
    virtual,
  );
  download(bytes, `${baseName}.parquet`, "application/octet-stream");
  return { file: `${baseName}.parquet`, note: null };
}

async function exportCsv(viewName, baseName) {
  const virtual = virtualName("csv");
  const bytes = await copyToBuffer(
    `COPY (SELECT * FROM ${viewName}) TO ${qlit(virtual)} (FORMAT CSV, HEADER)`,
    virtual,
  );
  download(bytes, `${baseName}.csv`, "text/csv");
  return { file: `${baseName}.csv`, note: null };
}

/**
 * The `geo` block a reader needs to treat a WKB column as geometry.
 *
 * `crs: null` is the spec's way of saying OGC:CRS84, so it is only honest for
 * a stream that really is lon/lat. A Reprojector upstream makes it a lie,
 * and the code goes in as a plain string instead — not the PROJJSON the spec
 * asks for, but unambiguous to a human reading the sidecar, which is the point
 * of writing one at all.
 */
function geoSidecar(geometryColumnName, crs) {
  return {
    version: "1.1.0",
    primary_column: geometryColumnName,
    columns: {
      [geometryColumnName]: {
        encoding: "WKB",
        geometry_types: [],
        crs: isLonLatCode(crs) ? null : crs,
      },
    },
  };
}

async function hasGeoMetadata(virtualFile) {
  try {
    const rows = await query(
      `SELECT count(*) AS n FROM parquet_kv_metadata(${qlit(virtualFile)}) WHERE decode(key) = 'geo'`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch (err) {
    console.warn("Could not inspect the written parquet's metadata", err);
    return false;
  }
}

async function exportGeoParquet(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  const geometry = findGeometryColumn(columns);
  if (!geometry) {
    // Nothing spatial to preserve, so this is just a parquet.
    const result = await exportParquet(viewName, baseName);
    return { ...result, note: "No geometry column — written as plain Parquet." };
  }

  // Present the geometry as DuckDB's GEOMETRY type, which is the only form the
  // spatial writer would attach metadata to.
  const others = columns
    .filter((column) => column.name !== geometry.name)
    .map((column) => qid(column.name));
  const selection = [...others, `${geometryExpression(geometry)} AS ${qid(geometry.name)}`].join(", ");
  const virtual = virtualName("parquet");

  // Not copyToBuffer(): the footer has to be inspected while the file is still
  // in the WASM filesystem, and that helper drops it on the way out.
  await exec(`COPY (SELECT ${selection} FROM ${viewName}) TO ${qlit(virtual)} (FORMAT PARQUET)`);
  let compliant = false;
  let bytes;
  try {
    compliant = await hasGeoMetadata(virtual);
    bytes = await db().copyFileToBuffer(virtual);
  } finally {
    try {
      await db().dropFile(virtual);
    } catch (err) {
      console.warn(`Could not drop ${virtual} from the WASM filesystem`, err);
    }
  }

  download(bytes, `${baseName}.parquet`, "application/octet-stream");
  // DuckDB writes no CRS into the block it does write, so a projected stream
  // would be read back as lon/lat. The sidecar is the only place left to say
  // what these coordinates are, which makes it worth writing even when the
  // block itself came out fine.
  const projected = !isLonLatCode(crs);
  if (compliant && !projected) {
    return { file: `${baseName}.parquet`, note: null };
  }

  const sidecar = JSON.stringify(geoSidecar(geometry.name, crs), null, 2);
  download(new TextEncoder().encode(sidecar), `${baseName}.geo.json`, "application/json");
  const reason = compliant
    ? `The geometry is in ${crs}, and DuckDB writes no CRS into GeoParquet — a reader will take it ` +
      "for lon/lat unless the .geo.json sidecar is applied."
    : "This build of DuckDB did not write the GeoParquet metadata block, so the geometry is " +
      "plain WKB and a .geo.json sidecar describes it. Most readers will need the sidecar applied.";
  return { file: `${baseName}.parquet`, note: reason };
}

/**
 * The `crs` member naming a projected GeoJSON's coordinate system.
 *
 * An authority code becomes the URN form GDAL emits and expects; anything else
 * — a raw `+proj=` string — goes in verbatim, which no reader will resolve
 * automatically but a human opening the file certainly will. Better than a
 * file that says nothing about coordinates that are plainly not degrees.
 */
function crsMember(crs) {
  const authority = /^([A-Za-z][\w.-]*):(\d+)$/.exec(crs);
  const name = authority ? `urn:ogc:def:crs:${authority[1].toUpperCase()}::${authority[2]}` : crs;
  return { type: "name", properties: { name } };
}

/*
 * GeoJSON, assembled in SQL rather than written by GDAL.
 *
 * duckdb-wasm ships GDAL and `st_drivers()` reports GeoJSON as writable, but
 * `COPY … (FORMAT GDAL, DRIVER 'GeoJSON')` dies on "Cannot write feature" in
 * the WASM filesystem — as does every other GDAL driver tried. ST_AsGeoJSON
 * and json_object are plain SQL and always there, so the document is built
 * from those instead: one row per feature, joined here.
 *
 * The coordinates go out in whatever the stream is already in. RFC 7946 says a
 * GeoJSON file is WGS84 and deleted the `crs` member to make the point, but
 * reprojecting on the way out would silently undo a Reprojector the user
 * put there deliberately — so a projected file keeps its coordinates and names
 * its CRS in the 2008 spec's `crs` member instead, which is what GDAL and QGIS
 * both write and read. Lon/lat, the common case, omits the member and is
 * RFC 7946 to the letter.
 *
 * A NULL geometry becomes `"geometry": null`, which every version of the spec
 * allows, rather than dropping the row and its attributes.
 */
async function exportGeoJson(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  const geometry = findGeometryColumn(columns);
  if (!geometry) {
    throw new Error("GeoJSON has to carry geometry and this output has none — write Parquet or CSV instead.");
  }
  // json_object takes alternating key literal and value, so the attribute
  // names survive spaces and accents that a struct_pack key would not.
  const pairs = columns
    .filter((column) => column.name !== geometry.name)
    .flatMap((column) => [qlit(column.name), qid(column.name)]);
  const properties = pairs.length ? `json_object(${pairs.join(", ")})` : "'{}'::JSON";

  const rows = await query(
    `SELECT json_object('type', 'Feature',` +
      ` 'geometry', ST_AsGeoJSON(${geometryExpression(geometry)})::JSON,` +
      ` 'properties', ${properties})::VARCHAR AS feature FROM ${viewName}`,
  );

  // The member sits between "type" and "features", where every reader that
  // still honours it expects to find it.
  const projected = !isLonLatCode(crs);
  const header = projected ? `"crs":${JSON.stringify(crsMember(crs))},` : "";
  const document =
    `{"type":"FeatureCollection",${header}"features":[${rows.map((row) => row.feature).join(",")}]}`;
  download(new TextEncoder().encode(document), `${baseName}.geojson`, "application/geo+json");
  return {
    file: `${baseName}.geojson`,
    note: projected
      ? `Written in ${crs}, named in the file's "crs" member. GDAL and QGIS honour that; a reader ` +
        "that follows RFC 7946 strictly will take the coordinates for lon/lat."
      : null,
  };
}

/** Integer types that can hold more than a double carries exactly. */
const WIDE_INTEGER = /^(U?BIGINT|HUGEINT|UHUGEINT)$/;
const NUMERIC = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;

/** Largest integer a double represents exactly, 2^53 - 1. */
const MAX_SAFE = "9007199254740991";

/**
 * How each column goes into a worksheet: the SQL that reads it and the kind
 * of cell it becomes.
 *
 * Every number is a double in Excel, so a 64-bit integer column whose values
 * pass 2^53 — an H3 index, a hashed ID — is written as text rather than
 * rounded into a different, valid-looking number. Whether a column needs that
 * is asked of the data, in one query, rather than assumed from its type.
 * Dates go as text the worker rebuilds into date cells; a zoned timestamp,
 * a time of day and anything nested become their text form.
 */
async function excelColumns(viewName, columns, geometry) {
  const wide = columns.filter((column) => column !== geometry && WIDE_INTEGER.test(column.type));
  let tooWide = new Set();
  if (wide.length) {
    const checks = wide.map(
      (column, i) => `bool_or(abs(${qid(column.name)}::HUGEINT) > ${MAX_SAFE}) AS w${i}`,
    );
    const [row] = await query(`SELECT ${checks.join(", ")} FROM ${viewName}`);
    tooWide = new Set(wide.filter((_, i) => row?.[`w${i}`]).map((column) => column.name));
  }
  return columns.map((column) => {
    const ref = qid(column.name);
    if (column === geometry) return { sql: `ST_AsText(${geometryExpression(geometry)})`, kind: "text" };
    if (tooWide.has(column.name)) return { sql: `${ref}::VARCHAR`, kind: "text" };
    if (NUMERIC.test(column.type)) return { sql: `${ref}::DOUBLE`, kind: "number" };
    if (column.type === "BOOLEAN") return { sql: ref, kind: "boolean" };
    if (column.type === "DATE") return { sql: `strftime(${ref}, '%Y-%m-%d')`, kind: "date" };
    if (/^TIMESTAMP(_S|_MS|_NS)?$/.test(column.type)) {
      return { sql: `strftime(${ref}, '%Y-%m-%dT%H:%M:%S')`, kind: "datetime" };
    }
    return { sql: `${ref}::VARCHAR`, kind: "text" };
  });
}

/** Excel's sheet-name rules: 31 characters at most, none of `[]:*?/\`. */
function sheetNameFor(baseName) {
  return baseName.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet1";
}

/*
 * Excel, one sheet, built by SheetJS in the spreadsheet worker so a big
 * export does not freeze the tab.
 *
 * A worksheet has no geometry type, so geometry goes out as WKT in a text
 * column under its own name — readable, and one ST_GeomFromText away from a
 * geometry again, including in this app. Excel holds 1,048,576 rows a sheet
 * and 32,767 characters a cell; an output over the first is refused up front,
 * and a WKT over the second — a detailed polygon easily is — is left blank
 * rather than cut, since a truncated WKT is not a smaller shape but a broken
 * one. The note says how many.
 */
async function exportExcel(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  if (columns.length > MAX_EXCEL_COLUMNS) {
    throw new Error(`${columns.length.toLocaleString()} columns is more than Excel's ${MAX_EXCEL_COLUMNS.toLocaleString()} — write Parquet or CSV instead.`);
  }
  const [{ n }] = await query(`SELECT count(*) AS n FROM ${viewName}`);
  if (Number(n) > MAX_EXCEL_ROWS) {
    throw new Error(
      `${Number(n).toLocaleString()} rows is more than one Excel sheet holds (${MAX_EXCEL_ROWS.toLocaleString()}) — ` +
        "filter upstream, or write Parquet or CSV.",
    );
  }
  const geometry = findGeometryColumn(columns);
  try {
    showProgress(`Reading ${Number(n).toLocaleString()} rows for ${baseName}.xlsx…`);
    const plan = await excelColumns(viewName, columns, geometry);
    // Positional aliases, so a column called "n" or "select" cannot collide.
    const selection = plan.map((column, i) => `${column.sql} AS c${i}`).join(", ");
    // Rows leave DuckDB as newline JSON written inside its own worker, and go
    // to the spreadsheet worker as bytes. Pulling them through query() instead
    // builds one JS object per row on the page — seven seconds of frozen tab
    // for 250,000 rows, which is the thing the worker exists to prevent.
    const virtual = virtualName("json");
    const ndjson = await copyToBuffer(
      `COPY (SELECT ${selection} FROM ${viewName}) TO ${qlit(virtual)} (FORMAT JSON)`,
      virtual,
    );

    const { bytes, blanked } = await writeWorkbook(
      {
        names: columns.map((column) => column.name),
        kinds: plan.map((column) => column.kind),
        ndjson,
        sheetName: sheetNameFor(baseName),
      },
      {
        onProgress: ({ stage, done, total }) => {
          if (stage === "zip") showProgress(`Compressing ${baseName}.xlsx…`);
          else showProgress(`Writing ${baseName}.xlsx — ${done.toLocaleString()} of ${total.toLocaleString()} rows`, done / total);
        },
      },
    );
    download(bytes, `${baseName}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const notes = [];
    if (geometry) {
      notes.push(
        `Geometry written as WKT in "${geometry.name}"` + (isLonLatCode(crs) ? "." : `, in ${crs} — the file itself cannot say so.`),
      );
    }
    if (blanked) {
      notes.push(
        `${blanked.toLocaleString()} cell${blanked === 1 ? " was" : "s were"} over Excel's 32,767-character limit and left blank.`,
      );
    }
    // Only a CRS or a blanked cell is a caveat; a lon/lat WKT column is just what Excel can hold.
    const caveat = blanked || (geometry && !isLonLatCode(crs));
    return { file: `${baseName}.xlsx`, note: caveat ? notes.join(" ") : null };
  } finally {
    hideProgress();
  }
}

const EXPORTERS = {
  Parquet: exportParquet,
  GeoParquet: exportGeoParquet,
  GeoJSON: exportGeoJson,
  CSV: exportCsv,
  Excel: exportExcel,
};

/** Formats that promise geometry, and so pay to build hexagons for an H3 view. */
const GEOMETRY_FORMATS = new Set(["GeoParquet", "GeoJSON"]);

/**
 * Run one Writer node.
 *
 * Returns {file, note} — `note` is a caveat worth surfacing, or null when the
 * export is exactly what was asked for.
 */
export async function runWriter(viewName, format, fileName, { crs = LONLAT } = {}) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new Error(`Unknown export format "${format}"`);
  const baseName = (fileName || "output").replace(/[^\w.-]/g, "_").replace(/\.(parquet|csv|geojson|json|xlsx)$/i, "");

  if (!GEOMETRY_FORMATS.has(format)) return exporter(viewName, baseName, crs);
  const columns = await describe(viewName);
  const isH3 = !findGeometryColumn(columns) && columns.some((column) => column.name === H3_INDEX_COLUMN);
  if (!isH3) return exporter(viewName, baseName, crs);

  _exportCounter += 1;
  const built = await materialiseH3Geometry(viewName, _exportCounter);
  if (!built) {
    const tooMany =
      `More than ${MAX_H3_EXPORT_CELLS.toLocaleString()} H3 cells — too many to build hexagons for. ` +
      `Filter upstream and export again`;
    // Parquet can still carry the index column and be useful; a GeoJSON with
    // no geometry is not a thing, so that one has to stop.
    if (format === "GeoJSON") throw new Error(`${tooMany}, or write Parquet to keep the ${H3_INDEX_COLUMN} column.`);
    const result = await exportParquet(viewName, baseName);
    return {
      ...result,
      note: `${tooMany}. Written with the ${H3_INDEX_COLUMN} column and no geometry.`,
    };
  }
  try {
    return await exporter(built.view, baseName, crs);
  } finally {
    for (const statement of built.cleanup) {
      await exec(statement).catch((err) => console.warn(`Could not clean up: ${statement}`, err));
    }
  }
}

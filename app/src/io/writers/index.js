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

import { copyToBuffer, exec, qid, qlit, query } from "../../core/duck.js";
import { LONLAT, describe, findGeometryColumn } from "../../core/schema.js";
import { H3_INDEX_COLUMN, MAX_MATERIALISED_CELLS, createCellGeometryTable } from "../../engines/h3/index.js";
import { exportExcel } from "./excel.js";
import { exportGeoJson, exportGeoParquet } from "./geo.js";

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
  return {
    view: joined,
    cells: cells.length,
    cleanup: [`DROP VIEW IF EXISTS ${joined}`, `DROP TABLE IF EXISTS ${tableName}`],
  };
}

/** Unique name in the WASM filesystem, so a double-click cannot race itself. */
export function virtualName(extension) {
  _exportCounter += 1;
  return `export_${_exportCounter}.${extension}`;
}

export function download(bytes, fileName, mimeType) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportParquet(viewName, baseName) {
  const virtual = virtualName("parquet");
  const bytes = await copyToBuffer(`COPY (SELECT * FROM ${viewName}) TO ${qlit(virtual)} (FORMAT PARQUET)`, virtual);
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

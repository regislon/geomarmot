/*
 * Binary fixtures, generated at test time and never committed.
 *
 * GeoPackage comes from ogr2ogr (GDAL; `gdal-bin` in CI) because the GDAL
 * inside DuckDB-Wasm can read GeoPackage but not write it. Parquet is written by
 * the engine under test (HarnessApi.tableToParquet). Workbooks come from SheetJS.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

export const GENERATED = "tests/fixtures/generated";

export function hasOgr2ogr() {
  try {
    execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A GeoPackage with one layer per entry of `layers` ({ name: GeoJSON FeatureCollection }). */
export function geopackage(fileName, layers, { srs = "EPSG:4326" } = {}) {
  mkdirSync(GENERATED, { recursive: true });
  const out = join(GENERATED, fileName);
  if (existsSync(out)) rmSync(out);
  for (const [name, collection] of Object.entries(layers)) {
    const src = join(GENERATED, `${name}.geojson`);
    writeFileSync(src, JSON.stringify(collection));
    execFileSync("ogr2ogr", ["-f", "GPKG", ...(existsSync(out) ? ["-update"] : []), "-a_srs", srs, "-nln", name, out, src], {
      stdio: "pipe",
    });
  }
  return readFileSync(out);
}

/** A FlatGeobuf file from a GeoJSON FeatureCollection. */
export function flatgeobuf(fileName, collection, { srs = "EPSG:4326" } = {}) {
  mkdirSync(GENERATED, { recursive: true });
  const out = join(GENERATED, fileName);
  const src = join(GENERATED, `${fileName}.geojson`);
  if (existsSync(out)) rmSync(out);
  writeFileSync(src, JSON.stringify(collection));
  execFileSync("ogr2ogr", ["-f", "FlatGeobuf", "-a_srs", srs, out, src], { stdio: "pipe" });
  return readFileSync(out);
}

export function points(rows) {
  return {
    type: "FeatureCollection",
    features: rows.map(([x, y, props]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [x, y] } })),
  };
}

/** An .xlsx from { sheetName: array-of-arrays }. */
export function workbook(sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

export function readWorkbook(bytes) {
  return XLSX.read(bytes, { type: "buffer", cellDates: false });
}

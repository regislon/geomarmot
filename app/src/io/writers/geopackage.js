/*
 * GeoPackage export: one layer, named after the file, in the stream's own
 * coordinate system.
 *
 * The rows are read from the Writer's input in batches and written into an
 * SQLite database built with sql.js (gpkg-format.js has the format). sql.js is
 * loaded on the first GeoPackage export only, and served with the app, so this
 * works offline too. Attributes keep their types where the GeoPackage has one
 * (INTEGER, REAL, TEXT, BOOLEAN, DATE, DATETIME, BLOB); anything else — lists,
 * structs — is written as text.
 */

import { conn, qid } from "../../core/duck.js";
import { LONLAT, describe, findGeometryColumn, geometryExpression } from "../../core/schema.js";
import { rowsOf } from "../../core/rows.js";
import { columnType, createCore, createLayer, geometryBlob, ident, registerLayer, srsFor } from "./gpkg-format.js";
import { download } from "./index.js";
import { reportProgress } from "../../ui/progress.js";

let sqlJs = null;
async function loadSqlJs() {
  if (!sqlJs) {
    const [{ default: init }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      import("sql.js/dist/sql-wasm-browser.wasm?url"),
    ]);
    sqlJs = await init({ locateFile: () => wasmUrl });
  }
  return sqlJs;
}

/** How a column is read for the GeoPackage: its SQL, and how its values are bound. */
function readAs(column, alias) {
  const ref = qid(column.name);
  const type = columnType(column.type);
  if (type === "INTEGER" || type === "BOOLEAN" || type === "BLOB") return `${ref} AS ${alias}`;
  if (type === "REAL") return `${ref}::DOUBLE AS ${alias}`;
  if (type === "DATE") return `strftime(${ref}, '%Y-%m-%d') AS ${alias}`;
  if (type === "DATETIME") return `strftime(${ref}::TIMESTAMP, '%Y-%m-%dT%H:%M:%S.%gZ') AS ${alias}`;
  return `${ref}::VARCHAR AS ${alias}`;
}

/** A value as sql.js binds it: wide integers as numbers when exact, or as text. */
function bindable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** A layer name the GeoPackage accepts: letters, digits and underscores, not starting with gpkg_. */
function layerName(baseName) {
  const name = baseName.replace(/[^\w]/g, "_").replace(/^gpkg_/i, "layer_") || "layer";
  return /^\d/.test(name) ? `layer_${name}` : name;
}

/**
 * @param {string} viewName
 * @param {string} baseName
 * @param {string} [crs]  the stream's coordinate system, which the layer keeps
 */
export async function exportGeoPackage(viewName, baseName, crs = LONLAT) {
  const SQL = await loadSqlJs();
  const columns = await describe(viewName);
  const geometry = findGeometryColumn(columns);
  const attributes = columns.filter((column) => column.name !== geometry?.name);
  const taken = new Set(attributes.map((column) => column.name.toLowerCase()));
  let fid = "fid";
  for (let k = 1; taken.has(fid); k++) fid = `fid_${k}`;
  const table = layerName(baseName);
  const geometryColumn = geometry ? geometry.name : null;

  const db = new SQL.Database();
  try {
    createCore(db);
    const srsId = geometry ? srsFor(db, crs) : null;
    createLayer(db, {
      table,
      fid,
      geometry: geometryColumn,
      columns: attributes.map((column) => ({ name: column.name, type: columnType(column.type) })),
    });

    const select = attributes.map((column, i) => readAs(column, `a${i}`));
    if (geometry) {
      const g = geometryExpression(geometry);
      select.push(
        `ST_AsWKB(${g}) AS __wkb`,
        `ST_IsEmpty(${g}) AS __empty`,
        `ST_GeometryType(${g})::VARCHAR AS __type`,
        `ST_HasZ(${g}) AS __z`,
        `ST_XMin(${g}) AS __x0`,
        `ST_XMax(${g}) AS __x1`,
        `ST_YMin(${g}) AS __y0`,
        `ST_YMax(${g}) AS __y1`,
      );
    }
    const names = [...(geometry ? [ident(geometryColumn)] : []), ...attributes.map((column) => ident(column.name))];
    const insert = db.prepare(
      names.length
        ? `INSERT INTO ${ident(table)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
        : `INSERT INTO ${ident(table)} DEFAULT VALUES`,
    );
    const types = new Set();
    let hasZ = false;
    let extent = null;
    let count = 0;

    const [{ n: total }] = rowsOf(await conn().query(`SELECT count(*) AS n FROM ${viewName}`));
    const rows = Number(total);
    db.run("BEGIN");
    // The main connection, streamed in batches: the Cancel button beside Run stops it.
    const reader = await conn().send(`SELECT ${select.join(", ") || "1 AS __one"} FROM ${viewName}`);
    for await (const batch of reader) {
      for (const row of rowsOf(batch)) {
        const values = [];
        if (geometry) {
          if (row.__wkb == null) values.push(null);
          else {
            const empty = Boolean(row.__empty);
            const envelope = empty ? null : { minx: row.__x0, maxx: row.__x1, miny: row.__y0, maxy: row.__y1 };
            values.push(geometryBlob(row.__wkb, srsId, envelope));
            if (!empty) {
              types.add(row.__type);
              hasZ ||= Boolean(row.__z);
              extent = extent
                ? [
                    Math.min(extent[0], row.__x0),
                    Math.min(extent[1], row.__y0),
                    Math.max(extent[2], row.__x1),
                    Math.max(extent[3], row.__y1),
                  ]
                : [row.__x0, row.__y0, row.__x1, row.__y1];
            }
          }
        }
        attributes.forEach((_, i) => values.push(bindable(row[`a${i}`])));
        insert.run(values);
        count += 1;
        if (count % 5000 === 0)
          reportProgress(`Writing ${baseName}.gpkg… ${count.toLocaleString()} of ${rows.toLocaleString()} rows`);
      }
    }
    insert.free();
    registerLayer(db, { table, geometry: geometryColumn, srsId: srsId ?? -1, extent, types, hasZ, count });
    db.run("COMMIT");

    const bytes = db.export();
    download(bytes, `${baseName}.gpkg`, "application/geopackage+sqlite3");
    const note = geometry
      ? null
      : `No geometry column — written as a GeoPackage attributes table (${count.toLocaleString()} rows).`;
    return { file: `${baseName}.gpkg`, note };
  } finally {
    db.close();
  }
}

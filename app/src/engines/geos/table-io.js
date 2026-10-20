// @ts-check
/*
 * Moving geometry between DuckDB and the overlay engine.
 *
 * Out of DuckDB: polygon parts as WKB (ST_AsWKB) with their envelopes, one row per part. Into DuckDB:
 * JSON lines carrying hex WKB, registered as files and read with read_json; ST_GeomFromHEXWKB rebuilds the
 * geometry exactly, unlike a WKT round trip. Files are cut at about `CHUNK_BYTES` and dropped once read.
 */

import { qlit } from "../../core/duck.js";

const CHUNK_BYTES = 8 * 1024 ** 2;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

/**
 * Every polygon part of every feature, with its feature id and envelope.
 *
 * @param {any} engine  a DuckDB engine (ctx.engine)
 * @param {string} source      a table or view
 * @param {string} fidColumn   a quoted column of unique feature ids
 * @param {string} geometry    a quoted geometry expression
 * @returns {Promise<{ fid: number[], wkb: Uint8Array[], bounds: Float64Array }>}
 */
export async function readParts(engine, source, fidColumn, geometry) {
  const rows = await engine.query(
    `SELECT fid, ST_AsWKB(part) AS wkb, ST_XMin(part) AS x0, ST_YMin(part) AS y0, ST_XMax(part) AS x1, ST_YMax(part) AS y1
     FROM (SELECT ${fidColumn} AS fid, UNNEST(ST_Dump(${geometry})).geom AS part FROM ${source} WHERE ${geometry} IS NOT NULL)
     WHERE ST_GeometryType(part) = 'POLYGON' AND NOT ST_IsEmpty(part)
     ORDER BY fid`,
  );
  const bounds = new Float64Array(rows.length * 4);
  rows.forEach((r, i) => bounds.set([r.x0, r.y0, r.x1, r.y1], 4 * i));
  return { fid: rows.map((r) => Number(r.fid)), wkb: rows.map((r) => r.wkb), bounds };
}

/**
 * Create `table` and fill it from JSON-lines records, in files of about CHUNK_BYTES.
 *
 * @param {any} engine  a DuckDB engine (ctx.engine)
 * @param {string} table
 * @param {string} columns  the CREATE TABLE column list
 * @param {string} select   the SELECT list over read_json's columns
 * @param {Iterable<object>} records
 */
export async function writeRecords(engine, table, columns, select, records) {
  await engine.exec(`CREATE OR REPLACE TABLE ${table} (${columns})`);
  const encoder = new TextEncoder();
  let lines = [];
  let bytes = 0;
  let chunk = 0;
  const flush = async () => {
    if (!lines.length) return;
    const name = `${table}_${chunk++}.json`;
    await engine.registerFileBuffer(name, encoder.encode(lines.join("\n")));
    try {
      await engine.exec(
        `INSERT INTO ${table} SELECT ${select} FROM read_json(${qlit(name)}, format = 'newline_delimited')`,
      );
    } finally {
      await engine.dropFile(name);
    }
    lines = [];
    bytes = 0;
  };
  for (const record of records) {
    const line = JSON.stringify(record);
    lines.push(line);
    bytes += line.length;
    if (bytes >= CHUNK_BYTES) await flush();
  }
  await flush();
}

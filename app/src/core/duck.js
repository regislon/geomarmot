/*
 * DuckDB-WASM boot, file registration and query helpers.
 *
 * Everything the app does to data goes through here. The engine runs in a
 * worker in the user's own browser: a dropped file is registered as a buffer
 * and never uploaded, and a remote file is read with range requests so opening
 * a 2 GB parquet costs a footer, not 2 GB.
 */

import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

/*
 * Both bundles ship with the app, and so do the extensions (see
 * scripts/fetch-duckdb-extensions.js): nothing is fetched from a CDN, which is
 * what lets the local server work with no network at all.
 */
const BUNDLES = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/**
 * Where the bundled extensions are served: the site root. In a build this
 * module sits in assets/, one folder down, so its own URL finds the root under
 * any path prefix and whichever page loaded it; the dev server serves them at /.
 */
function extensionRepository() {
  if (import.meta.env?.DEV) return new URL("/duckdb-extensions", window.location.href).href;
  return new URL("../duckdb-extensions", import.meta.url).href;
}

let _db = null;
let _conn = null;
let _spatial = false;
// registerFileURL / registerFileBuffer throw "File already registered" on a
// repeat name, so every registration is guarded by this set rather than by
// try/catch — a swallowed catch here would hide a genuine name collision
// between two files the user dropped with the same basename.
const _registered = new Set();

/** Quote an identifier so columns with spaces, accents or keywords survive. */
export function qid(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Quote a string literal for inlining into SQL. */
export function qlit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Arrow hands back proxies, BigInts and nested structs. Flatten to plain JS so
 * the rest of the app can treat a row as an ordinary object.
 */
export function normalize(value) {
  if (value == null) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return normalize(value.toJSON());
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value[Symbol.iterator] === "function") return Array.from(value, normalize);
    const out = {};
    for (const key in value) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

export async function boot() {
  if (_conn) return _conn;
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker);
  _db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await _db.instantiate(bundle.mainModule);
  _conn = await _db.connect();
  await _conn.query(`SET custom_extension_repository = '${extensionRepository()}'`);
  await loadSpatial();
  return _conn;
}

/**
 * Load the spatial extension up front.
 *
 * DuckDB auto-loads it when it *reads* a GeoParquet, which makes `ST_AsWKB`
 * appear to be built in — but only once such a file has been opened. Anything
 * that calls a spatial function first (building geometry from H3 indexes, say)
 * gets "Scalar Function with name st_geomfromwkb is not in the catalog" from a
 * database that would happily have loaded it. Doing it here removes the
 * ordering dependency.
 */
async function loadSpatial() {
  try {
    await _conn.query("INSTALL spatial");
    await _conn.query("LOAD spatial");
    // Loaded now rather than on first use, so extension autoloading can be
    // switched off later without breaking Parquet or JSON reads.
    await _conn.query("LOAD parquet");
    await _conn.query("LOAD json");
    _spatial = true;
  } catch (err) {
    // Worth continuing without: plain parquet still works entirely.
    console.warn("Spatial extension unavailable — geometry features are limited", err);
    _spatial = false;
  }
}

/** Whether spatial functions can be used. */
export function hasSpatial() {
  return _spatial;
}

export function db() {
  if (!_db) throw new Error("DuckDB is not started yet.");
  return _db;
}

export function conn() {
  if (!_conn) throw new Error("DuckDB is not started yet.");
  return _conn;
}

export function isRegistered(name) {
  return _registered.has(name);
}

/** Register a dropped file's bytes under a logical name. */
export async function registerBuffer(name, bytes) {
  if (_registered.has(name)) return name;
  await db().registerFileBuffer(name, bytes);
  _registered.add(name);
  return name;
}

/** Register a remote file for range reads under a logical name. */
export async function registerUrl(name, url) {
  if (_registered.has(name)) return name;
  await db().registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
  _registered.add(name);
  return name;
}

export async function dropFile(name) {
  if (!_registered.has(name)) return;
  await db().dropFile(name);
  _registered.delete(name);
}

/** Run a statement, ignoring the result. */
export async function exec(sql) {
  await conn().query(sql);
}

/**
 * Rebuild a DECIMAL from the little-endian 32-bit words Arrow hands back.
 *
 * Arrow carries a decimal as its unscaled 128-bit integer, and the scale lives
 * in the schema rather than on the value — so `toJSON()` produces the unscaled
 * digits and 1.50 arrives as "150". Anything wide enough to matter here is
 * beyond a double anyway; a Number is what the grid and the map can use.
 */
function decodeDecimal(words, scale) {
  if (words == null) return null;
  let magnitude = 0n;
  for (let i = words.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(words[i]);
  const bits = BigInt(words.length * 32);
  // Two's complement: the top bit set means the value is negative.
  const signed = magnitude >= 1n << (bits - 1n) ? magnitude - (1n << bits) : magnitude;
  return Number(signed) / 10 ** scale;
}

/** Scale by column name for the decimal fields of a result, or null if none. */
function decimalScales(schema) {
  const scales = new Map();
  for (const field of schema.fields) {
    // Only Decimal carries a numeric `scale`; Timestamp has `unit` instead.
    if (typeof field.type?.scale === "number") scales.set(field.name, field.type.scale);
  }
  return scales.size ? scales : null;
}

/** Run a query and return plain JS row objects. */
export async function query(sql) {
  const result = await conn().query(sql);
  const scales = decimalScales(result.schema);
  return result.toArray().map((row) => {
    const plain = normalize(row.toJSON());
    // Read the decimals off the Arrow row, where the words are still intact.
    if (scales) for (const [name, scale] of scales) plain[name] = decodeDecimal(row[name], scale);
    return plain;
  });
}

/** Run a query and return the Arrow table, for callers that want columns too. */
export async function queryArrow(sql) {
  return conn().query(sql);
}

/** Run a query expected to produce exactly one row. */
export async function queryOne(sql) {
  const rows = await query(sql);
  return rows.length ? rows[0] : null;
}

/**
 * Write a query result into the WASM filesystem and hand back the bytes.
 *
 * The virtual file is removed afterwards: leaving it behind holds the whole
 * export in WASM memory for the rest of the session, and a second export to the
 * same name would fail.
 */
export async function copyToBuffer(sql, virtualName) {
  await exec(sql);
  try {
    return await db().copyFileToBuffer(virtualName);
  } finally {
    try {
      await db().dropFile(virtualName);
    } catch (err) {
      console.warn(`Could not drop ${virtualName} from the WASM filesystem`, err);
    }
  }
}

/** A new connection to the same database, for work that must not share a transaction with the app's. */
export async function newConnection() {
  return db().connect();
}

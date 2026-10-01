/*
 * DuckDB-Wasm: boot, file registration, queries — and keeping the engine alive.
 *
 * Everything the app does to data goes through here. The engine runs in a
 * worker in the user's own browser: a dropped file is registered as a buffer
 * and never uploaded, and a remote file is read with range requests.
 *
 * A runaway query is stopped in two steps (docs/decisions/0004): cancelSent()
 * first, which stops most queries at once; if the engine does not answer within
 * a grace period — some nested-loop joins never check for it — the worker is
 * terminated and a fresh engine booted, and every source is registered again
 * from what was kept to restore it.
 */

import { memoryLimit } from "./memory.js";
import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { rowsOf } from "./rows.js";

export { normalize } from "./rows.js";

/* Both bundles and the extensions ship with the app: nothing comes from a CDN. */
const BUNDLES = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/** How long an interactive read may run before it is stopped. */
export const READ_TIMEOUT_MS = 30_000;
/** How long a cancelled query gets to stop before the engine is restarted. */
const CANCEL_GRACE_MS = 2_000;

let _db = null;
let _conn = null;
let _spatial = false;
let _restarts = 0;
/** name -> { url } or { restore: () => Promise<Uint8Array> }: how to register each file again. */
const _registrations = new Map();
/** table name -> Parquet bytes, for tables built on open (Excel sheets, Zarr arrays). */
const _snapshots = new Map();
const _restartListeners = new Set();
const _restartingListeners = new Set();

/**
 * Where the bundled extensions are served: the site root. In a build this
 * module sits in assets/, one folder down, so its own URL finds the root under
 * any path prefix and whichever page loaded it; the dev server serves them at /.
 */
function extensionRepository() {
  if (import.meta.env?.DEV) return new URL("/duckdb-extensions", window.location.href).href;
  return new URL("../duckdb-extensions", import.meta.url).href;
}

/** Quote an identifier so columns with spaces, accents or keywords survive. */
export function qid(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Quote a string literal for inlining into SQL. */
export function qlit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Boot one DuckDB instance with the bundled extensions, a memory ceiling and
 * extension autoloading switched off. Shared by the main engine and the
 * isolated preview engines.
 */
async function bootInstance({ memory = memoryLimit() } = {}) {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker);
  const instance = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await instance.instantiate(bundle.mainModule);
  const connection = await instance.connect();
  await connection.query(`SET custom_extension_repository = '${extensionRepository()}'`);
  await connection.query(`SET memory_limit = '${memory}'`);
  let spatial = false;
  try {
    await connection.query("INSTALL spatial");
    await connection.query("LOAD spatial");
    // Loaded explicitly, so autoloading can be switched off without breaking Parquet or JSON reads.
    await connection.query("LOAD parquet");
    await connection.query("LOAD json");
    // Defence in depth for the SQL guard: nothing may pull in another extension later.
    await connection.query("SET autoinstall_known_extensions = false");
    await connection.query("SET autoload_known_extensions = false");
    spatial = true;
  } catch (err) {
    console.warn("Spatial extension unavailable — geometry features are limited", err);
  }
  return { instance, connection, spatial };
}

async function start() {
  const booted = await bootInstance();
  _db = booted.instance;
  _conn = booted.connection;
  _spatial = booted.spatial;
}

export async function boot() {
  if (!_conn) await start();
  return _conn;
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

/** How many times the engine has been restarted this session. */
export function engineRestarts() {
  return _restarts;
}

/** Be told when a restart begins, and (onEngineRestart) when it is done and everything from before is gone. */
export function onEngineRestarting(listener) {
  _restartingListeners.add(listener);
  return () => _restartingListeners.delete(listener);
}

export function onEngineRestart(listener) {
  _restartListeners.add(listener);
  return () => _restartListeners.delete(listener);
}

/**
 * Terminate the worker, boot a fresh engine, and restore every source: files
 * are registered again, snapshot tables rebuilt from their Parquet copies.
 * Everything a compile made is gone; the listeners recompile.
 */
export async function restartEngine(reason = "a query did not stop when asked") {
  _restarts += 1;
  for (const listener of _restartingListeners) listener(reason);
  try {
    await _db?.terminate();
  } catch {
    // A worker stuck in a query cannot answer; terminate() still kills it.
  }
  _db = null;
  _conn = null;
  await start();
  for (const [name, how] of _registrations) {
    if (how.url) await _db.registerFileURL(name, how.url, duckdb.DuckDBDataProtocol.HTTP, false);
    else await _db.registerFileBuffer(name, await how.restore());
  }
  for (const [table, bytes] of _snapshots) {
    const file = `__snapshot_${table}.parquet`;
    await _db.registerFileBuffer(file, bytes.slice());
    await _conn.query(`CREATE TABLE ${qid(table)} AS SELECT * FROM read_parquet(${qlit(file)})`);
    await _db.dropFile(file);
  }
  for (const listener of _restartListeners) {
    try {
      await listener(reason);
    } catch (err) {
      console.warn("A restart listener failed", err);
    }
  }
}

export function isRegistered(name) {
  return _registrations.has(name);
}

/**
 * Register a file's bytes under a logical name. DuckDB takes the buffer, so
 * `restore` must be able to produce the bytes again after an engine restart —
 * for a dropped file, reading the File once more.
 */
export async function registerBuffer(name, bytes, restore = null) {
  if (_registrations.has(name)) return name;
  await db().registerFileBuffer(name, bytes);
  _registrations.set(name, { restore: restore || (() => Promise.reject(new Error(`${name} cannot be restored.`))) });
  return name;
}

/** Register a remote file for range reads under a logical name. */
export async function registerUrl(name, url) {
  if (_registrations.has(name)) return name;
  await db().registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
  _registrations.set(name, { url });
  return name;
}

export async function dropFile(name) {
  if (!_registrations.has(name)) return;
  _registrations.delete(name);
  await db().dropFile(name);
}

/** Keep a Parquet copy of a table built on open, so an engine restart can rebuild it. */
export async function rememberTable(table) {
  const file = `__snapshot_${table}.parquet`;
  _snapshots.set(table, await copyToBuffer(`COPY ${qid(table)} TO ${qlit(file)} (FORMAT PARQUET)`, file));
}

export function forgetTable(table) {
  _snapshots.delete(table);
}

/** Run a statement, ignoring the result. */
export async function exec(sql) {
  await conn().query(sql);
}

class QueryTimeout extends Error {}

/**
 * Run a query with a watchdog: cancel after `timeoutMs`, and restart the
 * engine if the cancel is not honoured within the grace period.
 *
 * Each watched query streams on a connection of its own: a connection holds one
 * pending streamed query at a time, so two reads sharing one would cut each
 * other off, and a cancel must only ever stop the query it was meant for.
 */
async function watched(sql, timeoutMs) {
  const connection = await db().connect();
  try {
    return await watchedOn(connection, sql, timeoutMs);
  } finally {
    connection.close().catch(() => {});
  }
}

async function watchedOn(connection, sql, timeoutMs) {
  const rows = [];
  let settled = false;
  const run = (async () => {
    const reader = await connection.send(sql);
    for await (const batch of reader) rows.push(...rowsOf(batch));
    return rows;
  })().finally(() => {
    settled = true;
  });
  let timer;
  const overdue = new Promise((resolve) => {
    timer = setTimeout(() => resolve("overdue"), timeoutMs);
  });
  const first = await Promise.race([run.then(() => "done"), overdue]).catch((err) => {
    clearTimeout(timer);
    throw err;
  });
  clearTimeout(timer);
  if (first === "done") return rows;
  const seconds = Math.round(timeoutMs / 1000);
  await Promise.race([connection.cancelSent().catch(() => {}), new Promise((r) => setTimeout(r, CANCEL_GRACE_MS))]);
  await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, CANCEL_GRACE_MS))]);
  if (settled) throw new QueryTimeout(`The query took longer than ${seconds} s and was stopped.`);
  await restartEngine(`a query ran past ${seconds} s and ignored the cancel`);
  throw new QueryTimeout(`The query took longer than ${seconds} s and did not stop, so the engine was restarted.`);
}

/**
 * Run a query and return plain JS row objects.
 * @param {string} sql
 * @param {{ timeoutMs?: number }} [options]  with a timeout, the watchdog applies
 */
export async function query(sql, { timeoutMs } = {}) {
  if (timeoutMs) return watched(sql, timeoutMs);
  return rowsOf(await conn().query(sql));
}

/** An interactive read (the table, the map, counts, suggestions): watched, with the standard timeout. */
export function readQuery(sql) {
  return query(sql, { timeoutMs: READ_TIMEOUT_MS });
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
 * Write a query result into the WASM filesystem and hand back the bytes. The
 * virtual file is removed afterwards, so it does not hold memory for the session.
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

/** Stop whatever the main connection is running (the Cancel beside Run). */
export async function cancelMain() {
  const stopped = await Promise.race([
    conn()
      .cancelSent()
      .then(() => true)
      .catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), CANCEL_GRACE_MS)),
  ]);
  if (!stopped) await restartEngine("an export was cancelled and did not stop");
}

/** A new connection to the same database, for work that must not share a transaction with the app's. */
export async function newConnection() {
  return db().connect();
}

/*
 * Engines: what the compiler and prepare steps run SQL on (ctx.engine).
 *
 * The main engine is the one above, holding the user's sources. An isolated
 * engine is a separate DuckDB instance in its own worker, for the assistant's
 * previews: it only ever holds sampled copies, and it can be terminated at any
 * moment without touching the user's graph (docs/decisions/0004).
 *
 * @typedef {object} Engine
 * @property {"main"|"isolated"} kind
 * @property {() => Promise<any>} connect                   a new connection
 * @property {(sql: string) => Promise<void>} exec
 * @property {(sql: string) => Promise<any[]>} query         plain row objects
 * @property {(name: string, bytes: Uint8Array) => Promise<void>} registerFileBuffer
 * @property {(name: string) => Promise<void>} dropFile
 */

/** @type {Engine} */
export const mainEngine = Object.freeze({
  kind: "main",
  connect: () => newConnection(),
  exec: (sql) => exec(sql),
  query: (sql) => query(sql),
  registerFileBuffer: (name, bytes) => db().registerFileBuffer(name, bytes),
  dropFile: (name) => db().dropFile(name),
});

/**
 * A separate DuckDB instance. `terminate()` kills its worker; anything still
 * running on it fails rather than hangs.
 * @returns {Promise<Engine & { terminate: () => Promise<void>, terminated: () => boolean }>}
 */
export async function createIsolatedEngine({ memory = "512MB" } = {}) {
  const { instance, connection } = await bootInstance({ memory });
  let dead = false;
  const alive = () => {
    if (dead) throw new Error("The preview engine was stopped.");
  };
  return {
    kind: "isolated",
    async connect() {
      alive();
      return instance.connect();
    },
    async exec(sql) {
      alive();
      await connection.query(sql);
    },
    async query(sql) {
      alive();
      return rowsOf(await connection.query(sql));
    },
    async registerFileBuffer(name, bytes) {
      alive();
      await instance.registerFileBuffer(name, bytes);
    },
    async dropFile(name) {
      alive();
      await instance.dropFile(name);
    },
    terminate: async () => {
      if (dead) return;
      dead = true;
      await instance.terminate().catch(() => {});
    },
    terminated: () => dead,
  };
}

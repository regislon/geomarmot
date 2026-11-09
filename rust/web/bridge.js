// The page's engine: DuckDB-Wasm in a Web Worker, exposed to Rust as globalThis.gmBridge.
// exec(sql), query(sql) → Arrow IPC stream bytes, overlay(request) → the GEOS worker pool of
// the JavaScript app (app/src/engines/geos), reused as the browser's overlay kernel.
import * as duckdb from "@duckdb/duckdb-wasm";
import { tableToIPC } from "apache-arrow";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { overlayFaces } from "../../app/src/engines/geos/index.js";

let db = null;
let conn = null;
let worker = null;

/** Start (or restart) the engine: bundled extensions only, from this page's own origin. */
export async function boot() {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  worker?.terminate();
  worker = new Worker(bundle.mainWorker);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
  await db.open({ path: ":memory:" });
  conn = await db.connect();
  await conn.query(`SET custom_extension_repository = '${location.origin}/extensions'`);
  await conn.query("SET autoinstall_known_extensions = false");
  await conn.query("SET autoload_known_extensions = false");
  for (const name of ["spatial", "json"]) {
    await conn.query(`INSTALL ${name}`);
    await conn.query(`LOAD ${name}`);
  }
  const [v] = (await conn.query("SELECT version() AS v")).toArray();
  return v.toJSON().v;
}

const plain = (v) => (typeof v === "bigint" ? Number(v) : v);

/** The engine interface the app's GEOS overlay expects (ctx.engine). */
const overlayEngine = {
  query: async (sql) =>
    (await conn.query(sql))
      .toArray()
      .map((r) => Object.fromEntries(Object.entries(r.toJSON()).map(([k, v]) => [k, plain(v)]))),
  exec: async (sql) => void (await conn.query(sql)),
  registerFileBuffer: (name, bytes) => db.registerFileBuffer(name, bytes),
  dropFile: (name) => db.dropFile(name),
};

globalThis.gmBridge = {
  exec: async (sql) => void (await conn.query(sql)),
  query: async (sql) => tableToIPC(await conn.query(sql), "stream"),
  overlay: async (request) => {
    const [source, fid, geometry, faces, memberships, ambiguous] = request.split("\n");
    const s = await overlayFaces(overlayEngine, { source, fid, geometry, faces, memberships, ambiguous });
    return `${s.faces} ${s.ambiguous} ${s.parts} ${s.tasks}`;
  },
  /** Cancel: what ADR 0004 does, terminate the worker and boot a fresh engine. */
  restart: boot,
};

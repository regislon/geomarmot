// The page's engine: DuckDB-Wasm in a Web Worker, exposed to Rust as globalThis.gmBridge.
// exec(sql), query(sql) → Arrow IPC stream bytes, overlay(request) → the GEOS worker pool of
// the JavaScript app (app/src/engines/geos), reused as the browser's overlay kernel.
import * as duckdb from "@duckdb/duckdb-wasm";
import { RecordBatchStreamWriter } from "apache-arrow";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { overlayFaces } from "../../app/src/engines/geos/index.js";

let db = null;
let conn = null;
let worker = null;
/** Sources picked by the user, replayed into a fresh engine after a restart. */
const sources = [];
/** Calls in flight, and how to make them fail when their engine is terminated. */
let inFlight = 0;
let abortEngine = () => {};
let engineGone = new Promise(() => {});

/** Run `call` on the current engine; it rejects if that engine is terminated meanwhile. */
async function run(call) {
  inFlight++;
  try {
    return await Promise.race([call(), engineGone]);
  } finally {
    inFlight--;
  }
}

/** Start (or restart) the engine: bundled extensions only, from this page's own origin. */
export async function boot() {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  worker?.terminate();
  abortEngine(new Error("INTERRUPT: the engine was restarted"));
  engineGone = new Promise((_, reject) => (abortEngine = reject));
  engineGone.catch(() => {});
  worker = new Worker(bundle.mainWorker);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
  await db.open({ path: ":memory:" });
  conn = await db.connect();
  await conn.query(`SET custom_extension_repository = '${location.origin}/extensions'`);
  await conn.query("SET autoinstall_known_extensions = false");
  await conn.query("SET autoload_known_extensions = false");
  for (const name of ["spatial", "json", "parquet"]) {
    await conn.query(`INSTALL ${name}`);
    await conn.query(`LOAD ${name}`);
  }
  for (const source of sources) {
    await db.registerFileBuffer(source.name, source.bytes.slice());
    await conn.query(source.sql);
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

const STOP_GRACE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a statement as a streaming query (the only kind cancelSent can stop); its result as Arrow IPC. */
async function stream(sql) {
  const reader = await conn.send(sql);
  const writer = new RecordBatchStreamWriter();
  writer.reset(undefined, reader.schema);
  for await (const batch of reader) writer.write(batch);
  writer.finish();
  return writer.toUint8Array(true);
}

globalThis.gmBridge = {
  // Several statements (a compile's BEGIN … COMMIT) cannot stream; they are DDL and finish quickly.
  exec: (sql) =>
    run(async () => void (/;\s*\S/.test(sql.trim().replace(/;\s*$/, "")) ? await conn.query(sql) : await stream(sql))),
  query: (sql) => run(() => stream(sql)),
  insertArrow: (table, ipc) => run(() => conn.insertArrowFromIPCStream(ipc.slice(), { name: table, create: true })),
  addSource: (name, bytes, sql) =>
    run(async () => {
      await db.registerFileBuffer(name, bytes.slice());
      await conn.query(sql);
      sources.push({ name, bytes, sql });
    }),
  /** Cooperative cancel; if work is still running after 2 s, terminate and reboot (ADR 0004). */
  cancel: async () => {
    if (!inFlight) return "Nothing to cancel.";
    const deadline = performance.now() + STOP_GRACE_MS;
    // The worker answers cancelSent only between chunks; never wait for it past the deadline.
    await Promise.race([conn.cancelSent().catch(() => false), sleep(STOP_GRACE_MS)]);
    while (inFlight && performance.now() < deadline) await sleep(20);
    if (!inFlight) return "Stopped.";
    await boot();
    return "Stopped (the engine was restarted).";
  },
  download: (copy, name) =>
    run(async () => {
      await conn.query(copy);
      const bytes = await db.copyFileToBuffer(name);
      await db.dropFile(name);
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([bytes])),
        download: name,
      });
      a.click();
      URL.revokeObjectURL(a.href);
    }),
  overlay: (request) =>
    run(async () => {
      const [source, fid, geometry, faces, memberships, ambiguous] = request.split("\n");
      const s = await overlayFaces(overlayEngine, { source, fid, geometry, faces, memberships, ambiguous });
      return `${s.faces} ${s.ambiguous} ${s.parts} ${s.tasks}`;
    }),
  /** Cancel: what ADR 0004 does, terminate the worker and boot a fresh engine. */
  restart: boot,
};

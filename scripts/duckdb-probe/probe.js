// Boots each bundled DuckDB-Wasm build and reports what it is (used by fetch-duckdb-extensions --update).
import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

window.probe = async () => {
  const out = [];
  for (const [wasm, worker] of [
    [mvpWasm, mvpWorker],
    [ehWasm, ehWorker],
  ]) {
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(worker));
    await db.instantiate(wasm);
    const conn = await db.connect();
    const version = (await conn.query("PRAGMA version")).toArray()[0].toJSON().library_version;
    const platform = (await conn.query("PRAGMA platform")).toArray()[0].toJSON().platform;
    await db.terminate();
    out.push({ version, platform });
  }
  return out;
};

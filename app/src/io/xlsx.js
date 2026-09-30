/*
 * Excel workbooks: each sheet flattened into a table of its own, and any
 * output written back out as a one-sheet workbook.
 *
 * Neither of DuckDB's routes to a workbook works in the browser. The `excel`
 * extension has no wasm build, and GDAL's XLSX driver — present in the spatial
 * extension's `st_drivers()` — reaches the zip inside the workbook through
 * `/vsizip/`, which cannot see a file DuckDB registered, so it answers "not
 * recognized as a supported file format" to a perfectly good .xlsx. So the
 * workbook is handled with SheetJS, in a worker (xlsx.worker.js): SheetJS is
 * synchronous, and on the page a big workbook would freeze the tab with no way
 * to say it was still working.
 *
 * SheetJS comes from its own CDN rather than npm: the npm package stopped at
 * 0.18.5, which has a prototype-pollution bug on crafted files
 * (CVE-2023-30533). The worker starts, and fetches it, the first time a
 * workbook is opened or written.
 */

import { db, exec, qid, qlit } from "../core/duck.js";

/** Rows per INSERT — the JSON for one batch sits in wasm memory at once. */
const INSERT_BATCH = 50_000;

let worker = null;
let requestCounter = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./xlsx.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") {
      request.onProgress?.(data);
      return;
    }
    pending.delete(data.id);
    if (data.type === "error") request.reject(new Error(data.message));
    else request.resolve(data);
  };
  // A failed module import (the CDN is unreachable) surfaces here, not as a
  // message — fail everything waiting and start afresh next time.
  worker.onerror = (event) => {
    event.preventDefault();
    const error = new Error(
      `The spreadsheet library did not load; check the network (${event.message || "worker failed"}).`,
    );
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/** One request to the worker; resolves with its `done` message. */
function call(type, payload, { transfer = [], onProgress = null } = {}) {
  requestCounter += 1;
  const id = requestCounter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

/**
 * Parse a workbook, keeping it in the worker for `materializeSheet`.
 *
 * Returns `{book, sheets}`: a handle, and every sheet's name and approximate
 * size, read from its declared range without flattening anything. Call
 * `closeWorkbook(book)` when done with it — the parsed workbook is the
 * largest thing this module holds.
 */
export async function readWorkbook(bytes, { onProgress = null } = {}) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const { book, sheets } = await call("open", { bytes: buffer }, { transfer: [buffer], onProgress });
  return { book, sheets };
}

/**
 * The top of a sheet for the header-row picker: displayed text, the sheet
 * row and column its first cell sits at, and the suggested header row.
 */
export async function previewSheet(book, sheetName) {
  return call("preview", { book, name: sheetName });
}

export async function closeWorkbook(book) {
  await call("close", { book }).catch((err) => console.warn("Could not release a workbook", err));
}

/**
 * Build the table for one sheet, or return null when it has no rows.
 *
 * The worker decides the column types from every cell and sends the rows as
 * newline-JSON batches; each is registered and inserted as it arrives, with
 * the types given explicitly so `read_json` does not re-guess them. Inserts
 * are chained, so they run in order however fast the batches come.
 *
 * `headerRow` is the sheet row holding the column names, 1-based as in
 * Excel; rows above it are skipped. Null takes the first non-blank row.
 *
 * `onProgress({stage, done, total})` is told when the worker is flattening
 * the sheet (`rows`, no count) and then after each inserted batch (`insert`).
 */
export async function materializeSheet(book, sheetName, tableName, { headerRow = null, onProgress = null } = {}) {
  let chain = Promise.resolve();
  let columnsStruct = null;
  let total = 0;
  // Chained so a failed INSERT stops the rest instead of racing them.
  const enqueue = (step) => {
    chain = chain.then(step);
  };

  const done = await call(
    "sheet",
    { book, name: sheetName, batch: INSERT_BATCH, headerRow },
    {
      onProgress: (message) => {
        if (message.stage === "rows") {
          onProgress?.({ stage: "rows" });
          return;
        }
        if (message.stage === "schema") {
          const { names, types } = message;
          total = message.total;
          columnsStruct = `{${names.map((name, i) => `${qlit(name)}: ${qlit(types[i])}`).join(", ")}}`;
          const defs = names.map((name, i) => `${qid(name)} ${types[i]}`).join(", ");
          enqueue(() => exec(`CREATE OR REPLACE TABLE ${tableName} (${defs})`));
          return;
        }
        if (message.batch) {
          const { bytes, to } = message.batch;
          const jsonName = `${tableName}_${to}.json`;
          enqueue(async () => {
            await db().registerFileBuffer(jsonName, bytes);
            try {
              await exec(
                `INSERT INTO ${tableName} SELECT * FROM read_json(${qlit(jsonName)}, ` +
                  `format='newline_delimited', columns=${columnsStruct})`,
              );
            } finally {
              await db().dropFile(jsonName);
            }
            onProgress?.({ stage: "insert", done: to, total });
          });
        }
      },
    },
  );
  await chain;
  if (!done.rows) return null;
  return { table: tableName, rows: done.rows };
}

/* ---------- writing ---------- */

/**
 * Excel's own ceilings: rows per sheet (one of them the header) and columns.
 * Past either, Excel refuses the file or silently drops the excess.
 */
export const MAX_EXCEL_ROWS = 1_048_576 - 1;
export const MAX_EXCEL_COLUMNS = 16_384;

/**
 * Write rows as a one-sheet .xlsx and return its bytes.
 *
 * `kinds` says, per column, how its values are to be written — `number`,
 * `boolean`, `date`, `datetime` or `text` — and `ndjson` is the rows as
 * newline JSON with keys `c0`, `c1`… in `names` order (DuckDB's
 * `COPY … (FORMAT JSON)`). The bytes are transferred, not copied. Returns
 * `{bytes, blanked}`, the second being how many cells were over Excel's
 * 32,767-character limit and so left empty.
 */
export async function writeWorkbook({ names, kinds, ndjson, sheetName }, { onProgress = null } = {}) {
  const buffer = ndjson.buffer;
  return call("write", { names, kinds, ndjson: buffer, sheetName }, { transfer: [buffer], onProgress });
}

// @ts-check
/*
 * A pool of overlay workers.
 *
 * Up to `workers` module workers each take the next task as soon as they are free. A worker is reused for
 * several tasks, but replaced once its WebAssembly heap passes `recycleHeapBytes`: that heap never shrinks,
 * and a 32-bit one cannot go past 4 GB. Aborting `signal`, a task past `taskWallMs`, or a failed task
 * terminates every worker and rejects; nothing keeps running in the background.
 */

import { pack, unpack } from "./wkb-pack.js";

const MAX_WORKERS = 4;
export const DEFAULT_TASK_WALL_MS = 10 * 60 * 1000;
export const DEFAULT_RECYCLE_HEAP_BYTES = 1.5 * 1024 ** 3;

/** Workers to use by default: all cores but one, at most four. */
export function defaultWorkers() {
  const cores = globalThis.navigator?.hardwareConcurrency || 2;
  return Math.max(1, Math.min(cores - 1, MAX_WORKERS));
}

/**
 * @typedef {object} TaskResult
 * @property {Uint8Array[]} faces
 * @property {Float64Array} areas
 * @property {Float64Array} bounds
 * @property {Int32Array} offsets
 * @property {Int32Array} members   indices into the task's own parts
 * @property {Float64Array} clearance
 * @property {Uint8Array} ambiguous
 * @property {Record<string, number>} stats
 */

/**
 * Overlay every task; results come back in task order.
 *
 * @param {Uint8Array[][]} tasks  the WKB parts of each task
 * @param {number} tau
 * @param {{ workers?: number, signal?: AbortSignal, taskWallMs?: number, recycleHeapBytes?: number,
 *           onTaskDone?: (done: number, total: number) => void }} [options]
 * @returns {Promise<TaskResult[]>}
 */
export function runTasks(tasks, tau, options = {}) {
  const {
    workers = defaultWorkers(),
    signal,
    taskWallMs = DEFAULT_TASK_WALL_MS,
    recycleHeapBytes = DEFAULT_RECYCLE_HEAP_BYTES,
    onTaskDone,
  } = options;
  const results = new Array(tasks.length);
  const live = new Set();
  let next = 0;
  let done = 0;
  let failed = false;
  const spawn = () => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    live.add(worker);
    return worker;
  };
  const retire = (worker) => {
    worker.terminate();
    live.delete(worker);
  };
  const stopAll = () => {
    failed = true;
    for (const worker of live) worker.terminate();
    live.clear();
  };
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      if (failed) return;
      stopAll();
      reject(err);
    };
    const onAbort = () => fail(new DOMException("The overlay was cancelled.", "AbortError"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const runSlot = async () => {
      let worker = spawn();
      while (!failed && next < tasks.length) {
        const index = next++;
        const result = await runOne(worker, tasks[index], tau, taskWallMs);
        if (failed) return;
        results[index] = result;
        onTaskDone?.(++done, tasks.length);
        if (result.stats.wasmHeapBytes > recycleHeapBytes) {
          retire(worker);
          worker = spawn();
        }
      }
      retire(worker);
    };
    const slots = Array.from({ length: Math.min(workers, tasks.length) }, runSlot);
    Promise.all(slots).then(
      () => {
        signal?.removeEventListener("abort", onAbort);
        if (!failed) resolve(results);
      },
      (err) => fail(err),
    );
  });
}

/** Send one task to a worker and wait for its answer, at most `wallMs`. */
function runOne(worker, partsWkb, tau, wallMs) {
  const { buffer, offsets } = pack(partsWkb);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`An overlay task ran past ${Math.round(wallMs / 1000)} s and was stopped.`));
    }, wallMs);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`The overlay worker failed: ${event.message || "out of memory?"}`));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      if (!data.ok) return reject(new Error(data.message));
      resolve({ ...data, faces: unpack(new Uint8Array(data.faces), data.faceOffsets) });
    };
    worker.postMessage({ parts: buffer, offsets, tau }, [buffer, offsets.buffer]);
  });
}

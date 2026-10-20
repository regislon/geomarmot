// @ts-check
/*
 * The GEOS overlay engine, seen from the page: run the overlay core in a module worker.
 *
 * GEOS (as WebAssembly, ~2.7 MB) is bundled with the app and loaded only by the worker, the first time an
 * overlay runs, so the initial page load does not pay for it. A worker is started per call and terminated
 * after it, or as soon as `signal` aborts.
 */

import { pack, unpack } from "./wkb-pack.js";

/**
 * @typedef {object} OverlayRun
 * @property {Uint8Array[]} faces
 * @property {Float64Array} areas
 * @property {Int32Array} offsets
 * @property {Int32Array} members
 * @property {Float64Array} clearance
 * @property {Uint8Array} ambiguous
 * @property {Record<string, number>} stats
 */

/**
 * Overlay WKB polygon parts in a worker.
 *
 * @param {Uint8Array[]} partsWkb
 * @param {number} tau  clearance tolerance, in the parts' coordinate units
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<OverlayRun>}
 */
export function overlayInWorker(partsWkb, tau, { signal } = {}) {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const { buffer, offsets } = pack(partsWkb);
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException("The overlay was cancelled.", "AbortError"));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`The overlay worker failed: ${event.message}`));
    };
    worker.onmessage = ({ data }) => {
      signal?.removeEventListener("abort", stop);
      worker.terminate();
      if (!data.ok) return reject(new Error(data.message));
      resolve({ ...data, faces: unpack(new Uint8Array(data.faces), data.faceOffsets) });
    };
    worker.postMessage({ parts: buffer, offsets, tau }, [buffer, offsets.buffer]);
  });
}

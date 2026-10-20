// @ts-check
/*
 * A module worker running the GEOS overlay core, so a long overlay never blocks the page.
 *
 * Message in:  { parts: ArrayBuffer (concatenated WKB), offsets: Uint32Array, tau: number }
 * Message out: { ok: true, faces: ArrayBuffer, faceOffsets: Uint32Array, areas, bounds, offsets, members, clearance,
 *               ambiguous, stats } or { ok: false, message }
 * Buffers travel as transferables in both directions: nothing is copied between threads.
 */

import initGeosJs from "geos-wasm";
import { overlayParts } from "./core.js";
import { pack, unpack } from "./wkb-pack.js";

/** @type {Promise<any> | null} */
let geosPromise = null;

self.onmessage = async ({ data }) => {
  try {
    const geos = await (geosPromise ??= initGeosJs());
    const t0 = performance.now();
    const result = overlayParts(geos, unpack(new Uint8Array(data.parts), data.offsets), data.tau);
    const { buffer: faces, offsets: faceOffsets } = pack(result.faces);
    const { areas, bounds, offsets, members, clearance, ambiguous } = result;
    const stats = { ...result.stats, totalMs: performance.now() - t0, wasmHeapBytes: geos.Module.HEAP8.length };
    self.postMessage({ ok: true, faces, faceOffsets, areas, bounds, offsets, members, clearance, ambiguous, stats }, [
      faces,
      faceOffsets.buffer,
      areas.buffer,
      bounds.buffer,
      offsets.buffer,
      members.buffer,
      clearance.buffer,
      ambiguous.buffer,
    ]);
  } catch (err) {
    self.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};

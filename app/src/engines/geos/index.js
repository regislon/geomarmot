// @ts-check
/*
 * The GEOS overlay engine, seen from the page.
 *
 * `overlayFaces` overlays every polygon of a DuckDB table at once and writes three tables:
 *   faces        face_id, geometry           one row per face covered by at least one feature
 *   memberships  face_id, fid                which features cover each face
 *   ambiguous    geometry, area, clearance   faces whose covering features could not be certified
 * Parts are clustered by proximity; a part alone in its cluster is its own face, the rest go to a pool of
 * workers running GEOS (WebAssembly, ~2.7 MB, loaded only by the workers). Face ids are assigned in a
 * fixed order (by envelope, then by covering features), so the same input always numbers its faces the
 * same way, whatever order the workers finish in.
 */

import { buildTasks, findClusters } from "./cluster.js";
import { runTasks } from "./pool.js";
import { readParts, toHex, writeRecords } from "./table-io.js";

export { MAX_OVERLAY_FEATURES } from "../../core/limits.js";

const TAU_FRACTION = 1e-9;

/** @type {((message: string | null) => void) | null} */
let reportProgress = null;

/** Where a long overlay announces itself; the app points this at the status line. */
export function setOverlayProgress(fn) {
  reportProgress = fn;
}

/**
 * Overlay one set of WKB parts in a single worker (tests and benchmarks).
 *
 * @param {Uint8Array[]} partsWkb
 * @param {number} tau
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function overlayInWorker(partsWkb, tau, { signal } = {}) {
  const [result] = await runTasks([partsWkb], tau, { workers: 1, signal });
  return result;
}

/**
 * @param {any} engine  a DuckDB engine (ctx.engine)
 * @param {{ source: string, fid: string, geometry: string, faces: string, memberships: string, ambiguous: string,
 *           signal?: AbortSignal, onProgress?: (message: string) => void, workers?: number }} options
 *   `fid` and `geometry` are quoted SQL; the three output names are table names.
 * @returns {Promise<{ faces: number, ambiguous: number, parts: number, tasks: number }>}
 */
export async function overlayFaces(engine, options) {
  const { source, fid, geometry, signal, workers } = options;
  const onProgress = options.onProgress ?? reportProgress;
  const parts = await readParts(engine, source, fid, geometry);
  if (!parts.wkb.length) {
    // Everything was rejected upstream (or there was nothing): empty tables, not an error.
    await writeFaces(engine, options, [], []);
    return { faces: 0, ambiguous: 0, parts: 0, tasks: 0 };
  }
  const tau = defaultTau(parts.bounds);
  const labels = findClusters(parts.bounds, tau);
  const { singletons, tasks } = buildTasks(
    labels,
    parts.wkb.map((w) => w.length),
  );
  onProgress?.(`Overlaying ${parts.wkb.length.toLocaleString()} polygon parts in ${tasks.length} task(s)…`);
  const results = await runTasks(
    tasks.map((task) => task.map((i) => parts.wkb[i])),
    tau,
    { signal, workers, onTaskDone: (done, total) => onProgress?.(`Overlay task ${done} of ${total} done…`) },
  );
  const { kept, ambiguous } = collectFaces(parts, singletons, tasks, results);
  onProgress?.(`Writing ${kept.length.toLocaleString()} faces…`);
  await writeFaces(engine, options, kept, ambiguous);
  return { faces: kept.length, ambiguous: ambiguous.length, parts: parts.wkb.length, tasks: tasks.length };
}

/** Clearance tolerance: a tiny fraction of the data extent (floating-noise scale), as the native engine. */
export function defaultTau(bounds) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < bounds.length; i += 4) {
    x0 = Math.min(x0, bounds[i]);
    y0 = Math.min(y0, bounds[i + 1]);
    x1 = Math.max(x1, bounds[i + 2]);
    y1 = Math.max(y1, bounds[i + 3]);
  }
  return Math.max(x1 - x0, y1 - y0, 1) * TAU_FRACTION;
}

/** Faces with their covering feature ids, in the fixed numbering order, and the ambiguous ones apart. */
function collectFaces(parts, singletons, tasks, results) {
  const kept = [];
  const ambiguous = [];
  for (const i of singletons) {
    kept.push({ wkb: parts.wkb[i], bounds: Array.from(parts.bounds.subarray(4 * i, 4 * i + 4)), fids: [parts.fid[i]] });
  }
  results.forEach((result, t) => {
    result.faces.forEach((wkb, f) => {
      const bounds = Array.from(result.bounds.subarray(4 * f, 4 * f + 4));
      if (result.ambiguous[f]) {
        ambiguous.push({ wkb, area: result.areas[f], clearance: result.clearance[f] });
        return;
      }
      const members = result.members.subarray(result.offsets[f], result.offsets[f + 1]);
      const fids = [...new Set(Array.from(members, (m) => parts.fid[tasks[t][m]]))].sort((a, b) => a - b);
      if (fids.length) kept.push({ wkb, bounds, fids });
    });
  });
  kept.sort((a, b) => compareNumbers(a.bounds, b.bounds) || compareNumbers(a.fids, b.fids));
  return { kept, ambiguous };
}

function compareNumbers(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

async function writeFaces(engine, { faces, memberships, ambiguous: ambiguousTable }, kept, ambiguous) {
  await writeRecords(
    engine,
    faces,
    "face_id BIGINT, geometry GEOMETRY",
    "i, ST_GeomFromHEXWKB(w)",
    kept.map((face, i) => ({ i, w: toHex(face.wkb) })),
  );
  await writeRecords(
    engine,
    memberships,
    "face_id BIGINT, fid BIGINT",
    "i, f",
    kept.flatMap((face, i) => face.fids.map((f) => ({ i, f }))),
  );
  await writeRecords(
    engine,
    ambiguousTable,
    "geometry GEOMETRY, area DOUBLE, clearance DOUBLE",
    "ST_GeomFromHEXWKB(w), a, c",
    ambiguous.map((face) => ({ w: toHex(face.wkb), a: face.area, c: face.clearance })),
  );
}

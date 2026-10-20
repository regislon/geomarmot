/*
 * Overlay benchmark: the GEOS worker against today's JSTS path, in Chromium. Reported, not asserted.
 *
 * Runs only when GEOS_BENCH=1. Optional: GEOS_BENCH_DATA=<dir> holding parts.bin (concatenated WKB) and
 * parts.json ({ tau, offsets }) for a real workload; GEOS_BENCH_OUT=<file> to write the results as JSON;
 * GEOS_BENCH_JSTS=1 to also time today's JSTS path, on workloads of at most JSTS_MAX_FEATURES only: it
 * unions boundaries one by one on the main thread, and did not finish 20,000 sparse boxes in 20 minutes.
 */

import { test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHarness } from "../harness/target.js";

test.skip(!process.env.GEOS_BENCH, "set GEOS_BENCH=1 to run the overlay benchmark");
test.setTimeout(1_800_000);

const DATA = process.env.GEOS_BENCH_DATA;
const JSTS = Boolean(process.env.GEOS_BENCH_JSTS);
const JSTS_MAX_FEATURES = 2_000;
const SYNTHETIC = [
  // name, boxes, min/max side, extent: sparse is mostly isolated boxes, dense is heavily overlapping.
  { name: "sparse-20k", n: 20_000, min: 0.01, max: 0.05, extent: 20 },
  { name: "dense-2k", n: 2_000, min: 0.5, max: 3, extent: 20 },
];

let h;
const results = [];
test.beforeAll(async ({ browser }) => {
  const files = new Map();
  if (DATA && existsSync(join(DATA, "parts.bin"))) {
    files.set("parts.bin", readFileSync(join(DATA, "parts.bin")));
    files.set("parts.json", readFileSync(join(DATA, "parts.json")));
  }
  h = await openHarness(browser, { files });
});
test.afterAll(async () => {
  console.log(JSON.stringify(results, null, 1));
  if (process.env.GEOS_BENCH_OUT) writeFileSync(process.env.GEOS_BENCH_OUT, JSON.stringify(results, null, 1));
  await h?.server.close();
});

for (const spec of SYNTHETIC) {
  test(`synthetic ${spec.name}: GEOS worker${JSTS && spec.n <= JSTS_MAX_FEATURES ? " vs JSTS" : ""}`, async () => {
    results.push(
      await h.page.evaluate(
        async ({ spec, withJsts }) => {
          const { geos: api } = window.__geomarmotInternals;
          const geos = await api.init();
          let seed = 42;
          const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
          const wkts = Array.from({ length: spec.n }, () => {
            const [x, y] = [rand() * spec.extent, rand() * spec.extent];
            const [w, hgt] = [spec.min + rand() * (spec.max - spec.min), spec.min + rand() * (spec.max - spec.min)];
            return `POLYGON((${x} ${y},${x + w} ${y},${x + w} ${y + hgt},${x} ${y + hgt},${x} ${y}))`;
          });
          const parts = wkts.map((wkt) => api.wktToWkb(geos, wkt));
          const heap = () => performance.memory?.usedJSHeapSize ?? null;
          let t0 = performance.now();
          const run = await api.overlayInWorker(parts, spec.extent * 1e-9);
          const geosMs = performance.now() - t0;
          const result = {
            workload: spec.name,
            features: spec.n,
            geos: {
              ms: geosMs,
              faces: run.faces.length,
              ambiguous: run.ambiguous.reduce((a, b) => a + b, 0),
              ...run.stats,
            },
            pageHeapBytes: heap(),
          };
          if (withJsts) {
            t0 = performance.now();
            const faces = await api.createFaceTable(wkts, `bench_faces_${spec.name.replace(/\W/g, "_")}`);
            result.jsts = { ms: performance.now() - t0, faces, note: "includes writing the faces into DuckDB" };
          }
          return result;
        },
        { spec, withJsts: JSTS && spec.n <= JSTS_MAX_FEATURES },
      ),
    );
  });
}

test("real workload from GEOS_BENCH_DATA: GEOS worker", async () => {
  test.skip(!DATA, "set GEOS_BENCH_DATA to a folder with parts.bin and parts.json");
  results.push(
    await h.page.evaluate(async () => {
      const { geos: api } = window.__geomarmotInternals;
      const meta = await (await fetch("/__files/parts.json")).json();
      const bytes = new Uint8Array(await (await fetch("/__files/parts.bin")).arrayBuffer());
      const parts = meta.offsets.slice(0, -1).map((start, i) => bytes.subarray(start, meta.offsets[i + 1]));
      const t0 = performance.now();
      const run = await api.overlayInWorker(parts, meta.tau);
      return {
        workload: "real",
        features: parts.length,
        vertices: meta.vertices,
        geos: {
          ms: performance.now() - t0,
          faces: run.faces.length,
          ambiguous: run.ambiguous.reduce((a, b) => a + b, 0),
          ...run.stats,
        },
        pageHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      };
    }),
  );
});

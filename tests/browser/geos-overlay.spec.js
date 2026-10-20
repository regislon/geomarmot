/*
 * The GEOS overlay engine in a real browser: the bundled worker gives the expected partition on every
 * parity case, and an aborted overlay stops its worker.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openHarness } from "../harness/target.js";

const PARITY = JSON.parse(readFileSync(new URL("../fixtures/geos-overlay-parity.json", import.meta.url), "utf8"));

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
});
test.afterAll(async () => h?.server.close());

test("the overlay worker matches the expected partition on every parity case", async () => {
  const problems = await h.page.evaluate(async (parity) => {
    const { geos: api } = window.__geomarmotInternals;
    const geos = await api.init();
    const out = {};
    for (const [name, expected] of Object.entries(parity.cases)) {
      const parts = expected.parts.map((wkt) => api.wktToWkb(geos, wkt));
      const result = await api.overlayInWorker(parts, parity.tau);
      out[name] = api.compareToExpected(geos, result, expected);
    }
    return out;
  }, PARITY);
  for (const name of Object.keys(PARITY.cases)) expect(problems[name], name).toEqual([]);
  expect(h.errors).toEqual([]);
});

test("an aborted overlay rejects with AbortError", async () => {
  const name = await h.page.evaluate(async (parity) => {
    const { geos: api } = window.__geomarmotInternals;
    const geos = await api.init();
    const parts = parity.cases.random.parts.map((wkt) => api.wktToWkb(geos, wkt));
    const controller = new AbortController();
    const run = api.overlayInWorker(parts, parity.tau, { signal: controller.signal });
    controller.abort();
    return run.then(
      () => "resolved",
      (err) => err.name,
    );
  }, PARITY);
  expect(name).toBe("AbortError");
});

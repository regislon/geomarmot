/*
 * Which app the browser suites run against.
 *
 *   HARNESS_TARGET=static:<dir>   an unbundled tree served from <dir> (/static/*.js)
 *   HARNESS_TARGET=bundle         the test build in dist-test/ (default once it exists)
 *
 * Returns a page with window.__geomarmotHarness booted and FixtureSource registered.
 */

import { existsSync } from "node:fs";
import { serve } from "./serve.js";

export function targetSpec() {
  const spec = process.env.HARNESS_TARGET || (existsSync("dist-test/harness.html") ? "bundle" : "static:app");
  if (spec === "bundle") return { kind: "bundle", root: "dist-test", page: "/harness.html" };
  const root = spec.slice("static:".length);
  return { kind: "static", root, page: "/__harness/static-tree.html" };
}

export async function openHarness(browser, { files } = {}) {
  const spec = targetSpec();
  const server = await serve({ root: spec.root, files });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(server.url + spec.page);
  await page.waitForFunction(() => window.__geomarmotHarness, null, { timeout: 60_000 });
  await page.evaluate(async () => {
    await window.__geomarmotHarness.boot();
    window.__geomarmotHarness.registerFixtureSource();
  });
  return { page, server, spec, errors };
}

/*
 * The app the browser suites run against: the test build in dist-test/, whose
 * harness entry (app/testing/harness-entry.js) provides HarnessApi v1.
 *
 * Returns a page with window.__geomarmotHarness booted and FixtureSource registered.
 */

import { serve } from "./serve.js";

export function targetSpec() {
  return { kind: "bundle", root: "dist-test", page: "/testing/harness.html" };
}
export async function openHarness(browser, { files, onRequest } = {}) {
  const spec = targetSpec();
  const server = await serve({ root: spec.root, files, onRequest });
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

#!/usr/bin/env node
/*
 * Capture fixture expectations from a reference app tree.
 *
 *   node scripts/capture-baseline.js --app-root <dir> [--only Type,Type] [--refresh]
 *
 * Runs every case in tests/fixtures/cases/*.json against the app served from
 * <dir> (an unbundled tree with /static/*.js), and writes each case's `expect`
 * from what it produced. Cases that already have an `expect` are kept unless
 * --refresh is given; cases with `assert` (random output) are never captured.
 *
 * A reference app may use older names for a transformer or an output column.
 * .local/rename-map.json maps them: { "types": { new: old }, "columns": { new: old } }.
 * Case files always use the new names; captured results are renamed back.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { serve } from "../tests/harness/serve.js";
import { runCase } from "../tests/harness/run-case.js";
import { formatFixture } from "../tests/harness/format.js";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = option("--app-root");
if (!root) {
  console.error("Usage: capture-baseline.js --app-root <dir> [--only A,B] [--refresh]");
  process.exit(2);
}
const only = option("--only")?.split(",");
const refresh = args.includes("--refresh");
const renames = existsSync(".local/rename-map.json")
  ? JSON.parse(readFileSync(".local/rename-map.json", "utf8"))
  : { types: {}, columns: {} };
const columnBack = Object.fromEntries(Object.entries(renames.columns || {}).map(([n, o]) => [o, n]));

const CASES = "tests/fixtures/cases";
const server = await serve({ root });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.error("page error:", err.message));
await page.goto(`${server.url}/__harness/static-tree.html`);
await page.waitForFunction(() => window.__geomarmotHarness, null, { timeout: 60000 });
await page.evaluate(async () => {
  await window.__geomarmotHarness.boot();
  window.__geomarmotHarness.registerFixtureSource();
});

let captured = 0;
let failed = 0;
for (const file of readdirSync(CASES)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(CASES, file);
  const suite = JSON.parse(readFileSync(path, "utf8"));
  if (only && !only.includes(suite.transformer)) continue;
  const type = renames.types?.[suite.transformer] || suite.transformer;
  for (const testCase of suite.cases) {
    if (testCase.assert || (testCase.expect && !refresh)) continue;
    try {
      const result = await runCase(page, type, testCase);
      if (result.error) {
        testCase.expect = { error: result.error.message };
      } else {
        const expect = {};
        for (const [port, table] of Object.entries(result.ports)) {
          expect[port] = {
            columns: table.columns.map((c) => ({ name: columnBack[c.name] || c.name, type: c.type })),
            rows: table.rows,
          };
        }
        if (result.crs && result.crs !== "EPSG:4326") expect.crs = result.crs;
        testCase.expect = expect;
      }
      captured++;
    } catch (err) {
      failed++;
      console.error(`${suite.transformer} / ${testCase.name}: ${err.message.split("\n")[0]}`);
    }
  }
  writeFileSync(path, formatFixture(suite));
}
await browser.close();
server.close();
console.log(`captured ${captured} case(s)${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);

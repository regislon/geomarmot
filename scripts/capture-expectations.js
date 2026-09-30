#!/usr/bin/env node
/*
 * Capture fixture expectations from the app's own engine, for review.
 *
 *   node scripts/capture-expectations.js [--only Type,Type] [--refresh]
 *
 * Runs the cases in tests/fixtures/cases/*.json and transformers/<id>/tests.json
 * through the bundled test harness (npm run build:test first) and writes each
 * case's `expect` from what it produced. Cases that already have an `expect` are
 * kept unless --refresh is given; cases with `assert` (random output) are never
 * captured. A captured expectation is a claim about behaviour: read it before
 * committing it.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openHarness } from "../tests/harness/target.js";
import { runCase } from "../tests/harness/run-case.js";
import { formatFixture } from "../tests/harness/format.js";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = option("--only")?.split(",");
const refresh = args.includes("--refresh");

function suiteFiles() {
  const files = [];
  if (existsSync("tests/fixtures/cases")) {
    for (const f of readdirSync("tests/fixtures/cases").sort())
      if (f.endsWith(".json")) files.push(join("tests/fixtures/cases", f));
  }
  for (const dir of existsSync("transformers") ? readdirSync("transformers").sort() : []) {
    const file = join("transformers", dir, "tests.json");
    if (!dir.startsWith("_") && existsSync(file)) files.push(file);
  }
  return files;
}

const browser = await chromium.launch();
const harness = await openHarness(browser);
harness.page.on("pageerror", (err) => console.error("page error:", err.message));

let captured = 0;
let failed = 0;
for (const path of suiteFiles()) {
  const suite = JSON.parse(readFileSync(path, "utf8"));
  if (only && !only.includes(suite.transformer)) continue;
  let changed = false;
  for (const testCase of suite.cases) {
    if (testCase.assert || (testCase.expect && !refresh)) continue;
    try {
      const result = await runCase(harness.page, suite.transformer, testCase);
      if (result.error) {
        testCase.expect = { error: result.error.message };
      } else if (result.file) {
        testCase.expect = {
          file: {
            name: result.file.name,
            ...(result.file.text !== null ? { text: result.file.text } : { table: result.file.table }),
          },
        };
      } else {
        const expect = {};
        for (const [port, table] of Object.entries(result.ports))
          expect[port] = { columns: table.columns, rows: table.rows };
        if (result.crs && result.crs !== "EPSG:4326") expect.crs = result.crs;
        testCase.expect = expect;
      }
      captured++;
      changed = true;
    } catch (err) {
      failed++;
      console.error(`${suite.transformer} / ${testCase.name}: ${err.message.split("\n")[0]}`);
    }
  }
  if (changed) writeFileSync(path, formatFixture(suite));
}
await browser.close();
harness.server.close();
console.log(`captured ${captured} case(s)${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);

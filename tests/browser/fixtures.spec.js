/*
 * Every fixture case, on the app's own engine.
 *
 * Cases come from transformers/<id>/tests.json and, until a transformer has
 * moved into its folder, from tests/fixtures/cases/<Type>.json.
 */

import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openHarness } from "../harness/target.js";
import { runCase, checkCase } from "../harness/run-case.js";

function suites() {
  const found = new Map();
  if (existsSync("transformers")) {
    for (const dir of readdirSync("transformers")) {
      const file = join("transformers", dir, "tests.json");
      if (dir.startsWith("_") || !existsSync(file)) continue;
      const suite = JSON.parse(readFileSync(file, "utf8"));
      found.set(suite.transformer, suite);
    }
  }
  for (const file of existsSync("tests/fixtures/cases") ? readdirSync("tests/fixtures/cases") : []) {
    if (!file.endsWith(".json")) continue;
    const suite = JSON.parse(readFileSync(join("tests/fixtures/cases", file), "utf8"));
    if (!found.has(suite.transformer)) found.set(suite.transformer, suite);
  }
  return [...found.values()].sort((a, b) => a.transformer.localeCompare(b.transformer));
}

const TYPE_ALIASES = JSON.parse(process.env.HARNESS_TYPE_ALIASES || "{}");
const COLUMN_ALIASES = JSON.parse(process.env.HARNESS_COLUMN_ALIASES || "{}");

let harness;
test.beforeAll(async ({ browser }) => {
  harness = await openHarness(browser);
});
test.afterAll(async () => {
  harness?.server.close();
});

for (const suite of suites()) {
  test.describe(suite.transformer, () => {
    for (const testCase of suite.cases) {
      test(testCase.name, async () => {
        const result = await runCase(harness.page, TYPE_ALIASES[suite.transformer] || suite.transformer, testCase);
        for (const table of Object.values(result.ports)) {
          for (const column of table.columns) column.name = COLUMN_ALIASES[column.name] || column.name;
        }
        expect(checkCase(result, testCase)).toEqual([]);
      });
    }
  });
}

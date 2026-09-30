/* The production build never contains the test harness. */

import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("dist/ has no harness entry and no harness code", () => {
  test.skip(!existsSync("dist/index.html"), "needs the production build (npm run build)");
  const all = files("dist");
  expect(all.filter((path) => /harness|testing/.test(path))).toEqual([]);
  for (const path of all.filter((p) => /\.(js|html)$/.test(p))) {
    expect(readFileSync(path, "utf8").includes("__geomarmotHarness"), path).toBe(false);
  }
});

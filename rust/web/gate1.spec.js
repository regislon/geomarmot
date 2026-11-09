// Spike gate 1 in Chromium: the page runs every gate-1 fixture through the Rust compiler (wasm)
// on DuckDB-Wasm. Run from the repository root after building the page:
//   npm --prefix rust/web run build:wasm && npm --prefix rust/web run build
//   npx playwright test --config rust/web/playwright.config.js
import { test, expect } from "@playwright/test";

test("every gate-1 fixture passes on DuckDB-Wasm", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__gate1, null, { timeout: 180_000 });
  const result = await page.evaluate(() => window.__gate1);
  console.log(`DuckDB ${result.version}: boot ${result.bootMs} ms, fixtures ${result.runMs} ms`);
  expect(result.failures).toEqual([]);
  expect(result.passed).toBe(37);
});

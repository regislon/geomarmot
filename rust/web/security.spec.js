// Spike gate 6, browser: the security rows on DuckDB-Wasm, locked as bridge.js boots it — once
// through DuckDB alone (the guard bypassed) and once through the Rust SQL guard.
import { test, expect } from "@playwright/test";

/** [row, SQL, DuckDB alone allows it] */
const ROWS = [
  ["read a file the page registered", "SELECT * FROM read_csv('/gm/approved.csv')", true],
  ["COPY to a file the page will hand over as a download", "COPY (SELECT 1 AS a) TO '/gm/export.csv'", true],
  ["read outside the page's directory", "SELECT * FROM read_csv('/other/x.csv')", false],
  ["read a URL", "SELECT * FROM read_csv('https://example.com/x.csv')", false],
  ["read a URL through GDAL", "SELECT * FROM ST_Read('https://example.com/x.geojson')", false],
  ["SET a setting", "SET memory_limit = '1GB'", false],
  ["RESET the allow list", "RESET allowed_directories", false],
  ["re-enable external access", "SET enable_external_access = true", false],
  // INSTALL alone is accepted by DuckDB-Wasm; what matters is that nothing unbundled loads.
  ["INSTALL and LOAD an unbundled extension", "INSTALL h3 FROM community; LOAD h3", false],
  ["LOAD an extension by path", "LOAD 'evil.duckdb_extension.wasm'", false],
  ["LOAD an already-loaded bundled extension", "LOAD spatial", true],
  ["create a secret", "CREATE SECRET s (TYPE s3, KEY_ID 'a', SECRET 'b')", false],
];

test("the locked browser engine and the guard", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__gate1, null, { timeout: 120_000 });
  const results = await page.evaluate(async (rows) => {
    const enc = new TextEncoder();
    await globalThis.gmBridge.addSource("approved.csv", enc.encode("a\n1\n"), "CREATE VIEW approved AS SELECT 1");
    const out = [];
    for (const [row, sql] of rows) {
      const duckdb = await globalThis.gmBridge.exec(sql).then(
        () => true,
        (e) => String(e.message || e),
      );
      const guard = await window.__validate(sql);
      out.push({ row, duckdb, guardAccepts: guard === "" });
    }
    return out;
  }, ROWS);
  const wrong = [];
  results.forEach((r, i) => {
    if ((r.duckdb === true) !== ROWS[i][2]) wrong.push(`${r.row}: DuckDB ${r.duckdb === true ? "allowed" : r.duckdb}`);
    if (r.guardAccepts) wrong.push(`${r.row}: the guard accepted it`);
  });
  console.log(results.map((r) => `${r.row}: DuckDB ${r.duckdb === true ? "allows" : "blocks"}`).join("\n"));
  expect(wrong).toEqual([]);
});

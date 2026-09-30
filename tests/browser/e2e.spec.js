/*
 * Smoke tests of the real UI: files in, graph open, export out.
 *
 * Goldens live in tests/fixtures/e2e/ and were recorded from the reference
 * app; UPDATE_GOLDENS=1 rewrites them (review the diff).
 */

import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as XLSX from "xlsx";
import { openApp } from "./app-target.js";

const GOLDENS = "tests/fixtures/e2e";

function golden(name, actual) {
  const path = `${GOLDENS}/${name}`;
  if (process.env.UPDATE_GOLDENS || !existsSync(path)) writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
  return JSON.parse(readFileSync(path, "utf8"));
}

const PEOPLE_CSV = "city,lon,lat,pop\nBern,7.44,46.95,134000\nZug,8.52,47.17,30000\nLugano,8.95,46.0,63000\n";

function graphFile(nodes, edges) {
  return JSON.stringify({ format: "geomarmot-graph", version: 1, nodes, edges });
}

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

test("CSV → points → GeoJSON export", async () => {
  const { page } = app;
  await page.setInputFiles("#file-input", {
    name: "people.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(PEOPLE_CSV),
  });
  await expect(page.locator("#status")).toContainText("3 rows");
  const x = { kind: "Attribute", column: "lon" };
  const y = { kind: "Attribute", column: "lat" };
  const graph = graphFile(
    [
      { id: "n1", type: "Reader", x: 40, y: 40, params: { sourceId: "s1__people.csv", rowNumber: "Auto" } },
      {
        id: "n2",
        type: "VertexCreator",
        x: 300,
        y: 40,
        params: { mode: "Replace with Point", x, y, removeAttributes: "Yes" },
      },
      {
        id: "n3",
        type: "Tester",
        x: 560,
        y: 40,
        params: { logic: "AND", conditions: [{ column: "pop", operator: ">", value: "50000" }] },
      },
      { id: "n4", type: "Writer", x: 820, y: 40, params: { format: "GeoJSON", filename: "big_cities" } },
    ],
    [
      { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
      { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
      { id: "e3", from: "n3", fromPort: "passed", to: "n4", toPort: "input" },
    ],
  );
  await page.setInputFiles("#graph-input", {
    name: "chain.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(graph),
  });
  await expect(page.locator("#status")).toContainText("4 nodes ready");

  // Port counts: the Tester splits 3 rows into 2 passed and 1 failed.
  const counts = page.locator('[data-node="n3"] .port-count');
  await expect(counts).toHaveCount(2);
  await expect(counts.nth(0)).toHaveText(/\b2$/);
  await expect(counts.nth(1)).toHaveText(/\b1$/);

  await expect(page.locator("#btn-export")).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export")]);
  expect(download.suggestedFilename()).toBe("big_cities.geojson");
  const geojson = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(geojson).toEqual(golden("big_cities.geojson.json", geojson));
  expect(geojson.features.map((f) => f.properties.city).sort()).toEqual(["Bern", "Lugano"]);
});

test("Excel: pick a sheet, then its header row", async () => {
  const { page } = app;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Quarterly report"],
      [],
      ["city", "E", "N", "since"],
      ["Bern", 2600000, 1200000, new Date(Date.UTC(2020, 0, 2))],
      ["Zug", 2681000, 1224000, new Date(Date.UTC(2021, 5, 30))],
    ]),
    "sites",
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["note"], ["ignore me"]]), "notes");
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  await page.setInputFiles("#file-input", { name: "book.xlsx", buffer: bytes });

  await expect(page.locator("#sheet-modal")).toBeVisible();
  await expect(page.locator("#sheet-hint")).toContainText("Step 1 of 2");
  await page.click("#sheet-add");
  await expect(page.locator("#sheet-body tr.header-row th.sheet-rownum")).toHaveText("3");
  await page.click("#sheet-add");
  await expect(page.locator("#sheet-modal")).toBeHidden();
  await expect(page.locator("#status")).toContainText("2 rows");
  await expect(page.locator("#source-list")).toContainText("book.xlsx");
});

test("dropping a file on the canvas adds a wired Reader and shows its rows", async () => {
  const { page } = app;
  const transfer = await page.evaluateHandle((csv) => {
    const data = new DataTransfer();
    data.items.add(new File([csv], "people.csv", { type: "text/csv" }));
    return data;
  }, PEOPLE_CSV);
  const box = await page.locator("#canvas-wrap").boundingBox();
  await page.dispatchEvent("#canvas-wrap", "drop", {
    dataTransfer: transfer,
    clientX: box.x + 100,
    clientY: box.y + 100,
  });
  await expect(page.locator("#canvas .node")).toHaveCount(1);
  await expect(page.locator("#canvas .node-title")).toHaveText("Reader");
  await expect(page.locator("#table-body tr")).toHaveCount(3);
});

test("a large workbook shows the loading bar while it is read", async () => {
  const { page } = app;
  const rows = [["id", "name", "v"], ...Array.from({ length: 30000 }, (_, k) => [k, `row ${k}`, k / 3])];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "big");
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  const shown = page.waitForSelector("#progress:not([hidden])", { timeout: 30_000 });
  await page.setInputFiles("#file-input", { name: "big.xlsx", buffer: bytes });
  await shown;
  await expect(page.locator("#progress-label")).not.toBeEmpty();
  await page.click("#sheet-add");
  await expect(page.locator("#status")).toContainText("30,000 rows", { timeout: 60_000 });
  await expect(page.locator("#progress")).toBeHidden();
});

/*
 * The progress card in the middle of the canvas: the engine starting, a file
 * opening, a graph running and files being written all show in it, and it goes
 * when they are done. Every label the card shows is recorded from the first
 * moment, so short-lived tasks are not missed.
 */

import { test, expect } from "@playwright/test";
import { serve } from "../harness/serve.js";

let server;
let context;
let page;

test.beforeEach(async ({ browser }) => {
  server = await serve({ root: "dist" });
  context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    window.__progress = [];
    document.addEventListener("DOMContentLoaded", () => {
      const card = document.getElementById("progress");
      const note = () => {
        if (!card.hidden)
          window.__progress.push(
            `${card.querySelector(".progress-label").textContent}|${card.querySelector(".progress-percent").textContent}`,
          );
      };
      new MutationObserver(note).observe(card, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  });
  page = await context.newPage();
  await page.goto(`${server.url}/`);
  await expect(page.locator("#status")).toContainText(/Drop a file|nodes ready/, { timeout: 90_000 });
});
test.afterEach(async () => {
  await context.close();
  server.close();
});

const seen = () => page.evaluate(() => window.__progress);

test("the engine's start shows in the middle of the canvas, and the card goes once it is ready", async () => {
  expect((await seen()).some((entry) => entry.startsWith("Starting the engine…"))).toBe(true);
  await expect(page.locator("#progress")).toBeHidden();
  // It is inside the canvas, centred on it.
  const card = await page.evaluate(() => document.getElementById("progress").parentElement.id);
  expect(card).toBe("canvas-wrap");
});

test("writing a GeoPackage shows its rows; quick steps do not flash a card", async () => {
  const rows = Array.from({ length: 60_000 }, (_, k) => `${k},${(k % 360) - 180},${(k % 170) - 85}`).join("\n");
  await page.setInputFiles("#file-input", {
    name: "many.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`id,lon,lat\n${rows}\n`),
  });
  await expect(page.locator("#status")).toContainText("60,000 rows");
  const graph = {
    format: "geomarmot-graph",
    version: 1,
    nodes: [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__many.csv" } },
      {
        id: "n2",
        type: "VertexCreator",
        x: 280,
        y: 60,
        params: {
          mode: "Replace with Point",
          x: { kind: "Attribute", column: "lon" },
          y: { kind: "Attribute", column: "lat" },
        },
      },
      { id: "n3", type: "Writer", x: 520, y: 60, params: { format: "GeoPackage", filename: "many" } },
    ],
    edges: [
      { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
      { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
    ],
  };
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(graph)),
  });
  await expect(page.locator("#btn-export")).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export")]);
  expect(download.suggestedFilename()).toBe("many.gpkg");
  await expect(page.locator("#progress")).toBeHidden();

  const labels = await seen();
  // Opening 60,000 rows takes less than the quarter second before a card shows, so none did.
  expect(labels.some((entry) => entry.startsWith("Opening many.csv…"))).toBe(false);
  expect(labels.some((entry) => entry.startsWith("Writing many"))).toBe(true);
  // The GeoPackage writer reports rows, and the card shows a percentage for them.
  expect(labels).toContain("Writing many.gpkg… 30,000 of 60,000 rows|50%");
});

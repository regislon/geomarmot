/*
 * The offline promise (docs/decisions/0008-offline-promise.md): the production
 * build's first load works with no network at all — a fresh browser profile,
 * every non-localhost request aborted from the very first one.
 */

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { serve } from "../harness/serve.js";
import { geopackage, hasOgr2ogr, points, workbook } from "../fixtures/build.js";

// OFFLINE_URL points the test at an installed server (the wheel, the Docker image) instead of dist/.
const target = process.env.OFFLINE_URL;
test.skip(!target && !existsSync("dist/index.html"), "needs the production build (npm run build)");

test("first load with the network blocked: spatial, GeoPackage and Excel all work", async ({ browser }) => {
  const server = target
    ? { url: target.replace(/\/$/, ""), close() {} }
    : await serve({ root: process.env.OFFLINE_ROOT || "dist" });
  const context = await browser.newContext();
  const blocked = [];
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost") return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(server.url + "/");
  await expect(page.locator("#status")).toContainText(/Drop a file|nodes ready/, { timeout: 90_000 });

  if (hasOgr2ogr()) {
    const gpkg = geopackage("offline.gpkg", { a: points([[1, 2, { n: "x" }]]), b: points([[3, 4, { n: "y" }]]) });
    await page.setInputFiles("#file-input", { name: "offline.gpkg", buffer: gpkg });
    await expect(page.locator("#status")).toContainText("2 layers");
  }
  const book = workbook({
    only: [
      ["id", "v"],
      [1, 2],
      [2, 3],
    ],
  });
  await page.setInputFiles("#file-input", { name: "offline.xlsx", buffer: book });
  await page.click("#sheet-add");
  await expect(page.locator("#status")).toContainText("2 rows");

  // Everything the app itself needs came from localhost. Basemap tiles are the
  // one thing that is online-only by nature; nothing else may have been asked for.
  const unexpected = blocked.filter((url) => !/tile\.openstreetmap\.org|arcgisonline\.com/.test(url));
  expect(unexpected).toEqual([]);
  await context.close();
  server.close();
});

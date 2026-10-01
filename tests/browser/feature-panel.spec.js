/*
 * The feature panel (a row's ⓘ): every attribute of the row, and the geometry
 * described — also for an administrative boundary of a hundred thousand
 * vertices, which used to run the Wasm parser out of memory.
 */

import { test, expect } from "@playwright/test";
import { openApp } from "./app-target.js";
import { geopackage, hasOgr2ogr } from "../fixtures/build.js";

test.skip(!hasOgr2ogr(), "needs ogr2ogr to build the GeoPackage");

const ring = (cx, n) => {
  const points = Array.from({ length: n }, (_, k) => [
    cx + Math.cos((2 * Math.PI * k) / n),
    Math.sin((2 * Math.PI * k) / n),
  ]);
  return [...points, points[0]];
};

test("a row's ⓘ shows all its attributes and its geometry, however large", async ({ browser }) => {
  const app = await openApp(browser);
  const { page } = app;
  try {
    const columns = Object.fromEntries(
      Array.from({ length: 30 }, (_, k) => [`attr_${String(k).padStart(2, "0")}`, `v${k}`]),
    );
    const features = [
      {
        type: "Feature",
        properties: { name: "small", ...columns },
        geometry: { type: "Polygon", coordinates: [ring(0, 8)] },
      },
      {
        type: "Feature",
        properties: { name: "boundary", ...columns, attr_29: null },
        geometry: { type: "MultiPolygon", coordinates: Array.from({ length: 5 }, (_, p) => [ring(p * 3, 20000)]) },
      },
    ];
    const bytes = geopackage("feature-panel.gpkg", { areas: { type: "FeatureCollection", features } });
    await page.setInputFiles("#file-input", {
      name: "areas.gpkg",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    await expect(page.locator("#status")).toContainText("rows");
    await page.click("#source-list button:has-text('Reader')");
    const box = await page.locator('[data-node="n1"] .node-title').boundingBox();
    await page.mouse.click(box.x + 12, box.y + box.height / 2);

    const body = page.locator("#geometry-body");
    await page.locator("#table-body .info-btn").first().click();
    await expect(body).toContainText("Attributes (31)");
    await expect(body).toContainText("attr_29");
    await expect(body).toContainText("POLYGON");
    await expect(body).toContainText("Holes");
    await page.click("#geometry-close");

    await page.locator("#table-body .info-btn").nth(1).click();
    await expect(body).toContainText("MULTIPOLYGON", { timeout: 30_000 });
    await expect(body).toContainText("100,005");
    await expect(body.locator(".geo-row.null")).toContainText("attr_29");
    await expect(body).not.toContainText("out of bounds");
  } finally {
    await app.context.close();
    app.server.close();
  }
});

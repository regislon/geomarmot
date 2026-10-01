/*
 * GeoPackage, end to end: the feature panel (a row's ⓘ) on a large boundary —
 * every attribute, and the geometry described without running the Wasm parser
 * out of memory — and the GeoPackage writer, checked by GDAL's own ogrinfo.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
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

test("Run writes a GeoPackage that GDAL itself reads: layer, CRS, types and features", async ({ browser }) => {
  const app = await openApp(browser);
  const { page } = app;
  try {
    const csv = "city,E,N,pop,capital\nBern,2600000,1200000,134591,true\nZug,2681000,1224000,30000,false\n";
    await page.setInputFiles("#file-input", { name: "swiss.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator("#status")).toContainText("rows");
    const graph = {
      format: "geomarmot-graph",
      version: 1,
      nodes: [
        { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__swiss.csv" } },
        {
          id: "n2",
          type: "VertexCreator",
          x: 280,
          y: 60,
          params: {
            mode: "Replace with Point",
            x: { kind: "Attribute", column: "E" },
            y: { kind: "Attribute", column: "N" },
          },
        },
        { id: "n3", type: "CoordinateSystemSetter", x: 520, y: 60, params: { crs: "EPSG:2056" } },
        { id: "n4", type: "Writer", x: 760, y: 60, params: { format: "GeoPackage", filename: "swiss_cities" } },
      ],
      edges: [
        { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
        { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
        { id: "e3", from: "n3", fromPort: "output", to: "n4", toPort: "input" },
      ],
    };
    await page.setInputFiles("#graph-input", {
      name: "g.flow.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(graph)),
    });
    await expect(page.locator("#btn-export")).toBeEnabled();
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export")]);
    expect(download.suggestedFilename()).toBe("swiss_cities.gpkg");
    const info = execFileSync("ogrinfo", ["-al", await download.path()], { encoding: "utf8" });
    expect(info).toContain("Layer name: swiss_cities");
    expect(info).toContain("Geometry: Point");
    expect(info).toContain("Feature Count: 2");
    expect(info).toMatch(/CH1903\+ \/ LV95/);
    expect(info).toMatch(/pop \(Integer64\) = 134591/);
    expect(info).toMatch(/city \(String\) = Zug/);
    expect(info).toContain("POINT (2600000 1200000)");
  } finally {
    await app.context.close();
    app.server.close();
  }
});

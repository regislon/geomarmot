/*
 * A Zarr store through the picker: arrays found from consolidated metadata, the
 * geo-reference read from attributes, a priced plan, and a layer added.
 */

import { test, expect } from "@playwright/test";
import { openApp, openLink } from "./app-target.js";

/** A 4×4 float32 array, uncompressed, with an affine transform and consolidated metadata. */
function zarrStore() {
  const zarray = {
    zarr_format: 2,
    shape: [4, 4],
    chunks: [4, 4],
    dtype: "<f4",
    compressor: null,
    fill_value: null,
    order: "C",
    filters: null,
  };
  const zattrs = {
    _ARRAY_DIMENSIONS: ["y", "x"],
    transform: [0.5, 0, 10, 0, -0.5, 50],
    crs_wkt: 'GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]',
  };
  const zmetadata = {
    zarr_consolidated_format: 1,
    metadata: { ".zgroup": { zarr_format: 2 }, "band/.zarray": zarray, "band/.zattrs": zattrs },
  };
  const chunk = Buffer.alloc(16 * 4);
  for (let i = 0; i < 16; i++) chunk.writeFloatLE(i, i * 4);
  const json = (value) => Buffer.from(JSON.stringify(value));
  return new Map([
    ["store.zarr/.zmetadata", json(zmetadata)],
    ["store.zarr/.zgroup", json({ zarr_format: 2 })],
    ["store.zarr/band/.zarray", json(zarray)],
    ["store.zarr/band/.zattrs", json(zattrs)],
    ["store.zarr/band/0.0", chunk],
  ]);
}

test("open a Zarr store: pick the array, see the cost, add the layer", async ({ browser }) => {
  const app = await openApp(browser, { files: zarrStore() });
  const { page } = app;
  await openLink(page, `${app.server.url}/__files/store.zarr`);
  await expect(page.locator("#zarr-modal")).toBeVisible();
  await expect(page.locator("#zarr-variables")).toContainText("band");
  await page.locator(".zarr-var", { hasText: "band" }).click();
  await expect(page.locator("#zarr-plan .zarr-cost")).toContainText(/chunk/);
  await expect(page.locator("#zarr-add")).toBeEnabled();
  await page.click("#zarr-add");
  await expect(page.locator("#zarr-modal")).toBeHidden();
  await expect(page.locator("#status")).toContainText("16 rows");
  await expect(page.locator("#source-list")).toContainText("band");
  await app.context.close();
  app.server.close();
});

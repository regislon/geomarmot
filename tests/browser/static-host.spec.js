/*
 * The app on a static host (GitHub Pages): no local server behind it, so the
 * bucket connector and gs:// paths say why they cannot work.
 */

import { test, expect } from "@playwright/test";
import { openApp, openLink } from "./app-target.js";

test("without the local server, the bucket connector and gs:// paths explain themselves", async ({ browser }) => {
  const app = await openApp(browser);
  try {
    const { page } = app;
    await page.click("#btn-connect");
    await page.click("[data-connector=gcs]");
    await expect(page.locator("#browse-note")).toContainText("local GeoMarmot server");
    await expect(page.locator("#browse-bucket")).toBeHidden();
    await page.click("#connect-close");
    await openLink(page, "gs://bucket/table.parquet");
    await expect(page.locator("#status")).toContainText("need the local server");
  } finally {
    await app.context.close();
    app.server.close();
  }
});

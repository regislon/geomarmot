/*
 * The app on a static host (GitHub Pages): no local server behind it, so no
 * bucket browser, and gs:// paths say why they cannot work.
 */

import { test, expect } from "@playwright/test";
import { openApp } from "./app-target.js";

test("without the local server, the bucket browser is hidden and gs:// paths explain themselves", async ({
  browser,
}) => {
  const app = await openApp(browser);
  try {
    const { page } = app;
    await expect(page.locator("#btn-browse")).toBeHidden();
    await page.fill("#url-input", "gs://bucket/table.parquet");
    await page.click("#btn-load-url");
    await expect(page.locator("#status")).toContainText("need the local server");
  } finally {
    await app.context.close();
    app.server.close();
  }
});

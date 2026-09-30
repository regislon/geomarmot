/*
 * Assistant settings: the key is kept in this tab unless remembered, can be
 * forgotten, and never ends up in the autosave or a saved graph.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openApp } from "./app-target.js";

const KEY = "sk-ant-test-0000-canary-key";

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

async function openSettings(page) {
  if (await page.locator("#assistant").isHidden()) await page.click("#btn-assistant");
  await expect(page.locator("#assistant")).toBeVisible();
  await page.click("#assistant-settings");
  await expect(page.locator("#ai-settings-modal")).toBeVisible();
}

const storage = (page) =>
  page.evaluate(() => ({
    session: JSON.stringify({ ...sessionStorage }),
    local: JSON.stringify({ ...localStorage }),
  }));

test("defaults: Claude Opus 5.5 from the browser, at level 1", async () => {
  const { page } = app;
  await openSettings(page);
  await expect(page.locator('input[name="ai-provider"][value="anthropic"]')).toBeChecked();
  await expect(page.locator('input[name="ai-transport"][value="browser"]')).toBeChecked();
  // No local server here, so the server route is offered but disabled.
  await expect(page.locator('input[name="ai-transport"][value="server"]')).toBeDisabled();
  await expect(page.locator("#ai-settings-body select").first()).toHaveValue("claude-opus-5-5");
  await expect(page.locator('input[name="ai-level"][value="1"]')).toBeChecked();
});

test("a key is kept in this tab only, unless remembered; Forget removes it", async () => {
  const { page } = app;
  await openSettings(page);
  await page.fill("#ai-key", KEY);
  await page.click("#ai-settings-save");
  let kept = await storage(page);
  expect(kept.session).toContain(KEY);
  expect(kept.local).not.toContain(KEY);

  await openSettings(page);
  await page.check("#ai-remember");
  await page.click("#ai-settings-save");
  kept = await storage(page);
  expect(kept.local).toContain(KEY);
  expect(kept.session).not.toContain(KEY);

  await openSettings(page);
  await page.click("#ai-forget");
  await page.click("#ai-settings-save");
  kept = await storage(page);
  expect(kept.local + kept.session).not.toContain(KEY);
});

test("settings survive a reload; closing without Save changes nothing", async () => {
  const { page } = app;
  await openSettings(page);
  await page.check('input[name="ai-level"][value="2"]');
  await page.click("#ai-settings-save");
  await openSettings(page);
  await page.check('input[name="ai-level"][value="3"]');
  await page.click("#ai-settings-close");
  await page.reload();
  await expect(page.locator("#status")).toContainText(/Drop a file|nodes ready/, { timeout: 90_000 });
  await openSettings(page);
  await expect(page.locator('input[name="ai-level"][value="2"]')).toBeChecked();
});

test("the key never reaches the autosave or a saved graph", async () => {
  const { page } = app;
  await openSettings(page);
  await page.fill("#ai-key", KEY);
  await page.check("#ai-remember");
  await page.click("#ai-settings-save");
  await page.setInputFiles("#file-input", { name: "c.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
  await expect(page.locator("#status")).toContainText("rows");
  const autosave = await page.evaluate(() => localStorage.getItem("geomarmot:graph.v1") || "");
  expect(autosave).not.toContain(KEY);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export-graph")]);
  expect(readFileSync(await download.path(), "utf8")).not.toContain(KEY);
});

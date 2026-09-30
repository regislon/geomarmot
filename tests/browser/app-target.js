/*
 * The real app page for end-to-end tests (never the harness entry).
 *
 * The production build in dist/.
 */

import { serve } from "../harness/serve.js";

export async function openApp(browser) {
  const server = await serve({ root: "dist" });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(server.url + "/");
  await page.waitForFunction(
    () => /Drop a file|nodes ready/.test(document.getElementById("status")?.textContent || ""),
    null,
    {
      timeout: 90_000,
    },
  );
  return { page, server, context, errors };
}

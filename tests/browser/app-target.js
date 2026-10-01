/*
 * The real app page for end-to-end tests (never the harness entry).
 *
 * The production build in dist/.
 */

import { serve } from "../harness/serve.js";

export async function openApp(browser, { files } = {}) {
  const server = await serve({ root: "dist", files });
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

/** Open a link through the Connect window's Web address connector. */
export async function openLink(page, link) {
  await page.click("#btn-connect");
  await page.click("[data-connector=url]");
  await page.fill("#url-input", link);
  await page.click("#btn-load-url");
}

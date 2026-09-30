/*
 * The real app page for end-to-end tests (never the harness entry).
 *
 *   HARNESS_TARGET=static:<dir>  the unbundled tree, served as it is
 *   HARNESS_TARGET=bundle        the production build in dist/
 */

import { serve } from "../harness/serve.js";

export async function openApp(browser) {
  const spec = process.env.HARNESS_TARGET || "bundle";
  const root = spec === "bundle" ? "dist" : spec.slice("static:".length);
  const server = await serve({ root });
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

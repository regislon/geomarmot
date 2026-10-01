/*
 * The local server with the real app (gate S5, docs/decisions/0005-proxy-auth.md):
 * gs:// Parquet and GeoPackage are read through /proxy with range requests, and
 * only by a page that traded the launch token for a session.
 */

import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { serve } from "../harness/serve.js";
import { geopackage, hasOgr2ogr, points } from "../fixtures/build.js";
import { openLink } from "./app-target.js";

const hasUv = (() => {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
test.skip(!existsSync("dist/index.html") || !hasUv, "needs the production build and uv");

const freePort = () =>
  new Promise((ready) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ready(port));
    });
  });

let upstream;
let server;
let url;
const requests = [];
const TOKEN = "browser-test-token";

test.beforeAll(async () => {
  // Fake storage: /<bucket>/<key>, with range support, recording what it is asked for.
  const root = "tests/fixtures/generated/gcs";
  mkdirSync(join(root, "bucket"), { recursive: true });
  const csv = ["id,v", ...Array.from({ length: 20000 }, (_, k) => `${k},${k * 2}`)].join("\n");
  writeFileSync(join(root, "bucket/table.csv"), csv);
  if (hasOgr2ogr())
    writeFileSync(join(root, "bucket/sites.gpkg"), geopackage("sites.gpkg", { sites: points([[7, 46, { n: "a" }]]) }));
  // The storage JSON API's listing, as the fake serves it (query strings are ignored).
  mkdirSync(join(root, "storage/v1/b/bucket"), { recursive: true });
  writeFileSync(
    join(root, "storage/v1/b/bucket/o"),
    JSON.stringify({
      prefixes: ["tiles/"],
      items: [{ name: "table.csv", size: String(csv.length), updated: "2026-01-01T00:00:00Z" }],
    }),
  );
  upstream = await serve({
    root,
    onRequest: (req) => requests.push({ path: req.url, range: req.headers.range || null }),
  });

  const port = await freePort();
  server = spawn(
    "uv",
    [
      "run",
      "--project",
      "server",
      "python",
      "server/tests/support/serve_for_browser_tests.py",
      "--port",
      String(port),
      "--static",
      "dist",
      "--token",
      TOKEN,
      "--gcs",
      upstream.url,
    ],
    { stdio: "inherit" },
  );
  url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the local server did not start");
});

test.afterAll(() => {
  server?.kill();
  upstream?.close();
});

async function openApp(browser, withToken) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${url}/${withToken ? `#t=${TOKEN}` : ""}`);
  await expect(page.locator("#status")).toContainText(/Drop a file|nodes ready/, { timeout: 90_000 });
  expect(page.url()).not.toContain(TOKEN);
  return { context, page };
}

const loadUrl = openLink;

test("with a session, gs:// files are read through the proxy with range requests", async ({ browser }) => {
  const { context, page } = await openApp(browser, true);
  requests.length = 0;
  await loadUrl(page, "gs://bucket/table.csv");
  await expect(page.locator("#status")).toContainText("20,000 rows");
  if (hasOgr2ogr()) {
    await loadUrl(page, "gs://bucket/sites.gpkg");
    await expect(page.locator("#status")).toContainText("1 rows");
    expect(requests.some((r) => r.path === "/bucket/sites.gpkg" && r.range)).toBe(true);
  }
  expect(requests.some((r) => r.path === "/bucket/table.csv" && r.range)).toBe(true);
  await context.close();
});

test("without the launch token, the proxy refuses", async ({ browser }) => {
  const { context, page } = await openApp(browser, false);
  requests.length = 0;
  await loadUrl(page, "gs://bucket/table.csv");
  await expect(page.locator("#status")).toContainText(/Could not read/);
  expect(requests).toEqual([]);
  await context.close();
});

test("the bucket connector lists a bucket through the server, opens a file and remembers the place", async ({
  browser,
}) => {
  const { context, page } = await openApp(browser, true);
  await page.click("#btn-connect");
  await page.click("[data-connector=gcs]");
  await expect(page.locator("#connector-gcs")).toBeVisible();
  await page.fill("#browse-bucket", "bucket");
  await page.click("#browse-go");
  await expect(page.locator("#browse-list")).toContainText("table.csv");
  await expect(page.locator("#browse-list")).toContainText("tiles");
  await page.locator("#browse-list").getByText("table.csv").click();
  await expect(page.locator("#connect-modal")).toBeHidden();
  await expect(page.locator("#status")).toContainText("20,000 rows");
  // Reopened after a reload: the bucket connector, in the bucket it was left in.
  await page.reload();
  await expect(page.locator("#status")).toContainText(/Drop a file|nodes ready/, { timeout: 90_000 });
  await page.click("#btn-connect");
  await expect(page.locator("#connector-gcs")).toBeVisible();
  await expect(page.locator("#browse-list")).toContainText("table.csv");
  await context.close();
});

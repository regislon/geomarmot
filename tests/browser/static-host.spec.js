/*
 * The app on a static host (GitHub Pages): no local server behind it, so
 * buckets are read with a Google sign-in, straight from the browser.
 *
 * Google is faked: its sign-in script hands over a made-up token, and the
 * storage JSON API is answered here, which also checks the token arrives as a
 * header and nowhere else.
 */

import { test, expect } from "@playwright/test";
import { openApp, openLink } from "./app-target.js";

const TOKEN = "test-token";
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CSV = "id,name\n1,a\n2,b\n3,c\n";

const FAKE_GIS = `window.google = { accounts: { oauth2: {
  initTokenClient: (config) => ({ requestAccessToken: () => setTimeout(() => config.callback({ access_token: "${TOKEN}", expires_in: 3600 }), 10) }),
  revoke: (token, done) => done && done({ successful: true }),
} } };`;

async function fakeGoogle(context) {
  const seen = [];
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_GIS }),
  );
  await context.route("https://storage.googleapis.com/**", (route) => {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,range",
      "access-control-expose-headers": "content-length,content-range",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    seen.push({ url: url.href, authorization: request.headers().authorization });
    if (request.headers().authorization !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, headers: cors });
    if (url.searchParams.get("alt") === "media")
      return route.fulfill({ headers: cors, contentType: "text/csv", body: CSV });
    const page =
      url.searchParams.get("prefix") === "data/"
        ? {
            items: [
              { name: "data/table.csv", size: String(CSV.length) },
              { name: "data/notes.txt", size: "5" },
            ],
          }
        : { prefixes: ["data/", "cube.zarr/"] };
    return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify(page) });
  });
  return seen;
}

test("without the local server, buckets are read with a Google sign-in", async ({ browser }) => {
  const app = await openApp(browser);
  try {
    const { page, context } = app;
    const seen = await fakeGoogle(context);
    await page.click("#btn-connect");
    await page.click("[data-connector=gcs]");
    await expect(page.locator("#gcs-sign-in")).toBeVisible();
    await expect(page.locator("#browse-bucket")).toBeHidden();
    // Not registered yet: the button leads to the setup.
    await page.click("#gcs-sign-in");
    await expect(page.locator("#gcs-google-text")).toContainText("OAuth client ID");
    // The ? explains how to get one, with this site's origin to register; Escape closes only it.
    await page.click("#gcs-client-help");
    await expect(page.locator("#gcs-help-origin")).toHaveText(new URL(page.url()).origin);
    await page.keyboard.press("Escape");
    await expect(page.locator("#gcs-help-modal")).toBeHidden();
    await expect(page.locator("#connect-modal")).toBeVisible();
    await page.fill("#gcs-client-id", CLIENT_ID);
    await page.click("#gcs-client-save");
    await page.click("#gcs-sign-in");
    await expect(page.locator("#gcs-sign-out")).toBeVisible();
    await page.fill("#browse-bucket", "bucket");
    await page.click("#browse-go");
    await expect(page.locator("#browse-list")).toContainText("Zarr: needs the local server");
    await page.locator("#browse-list").getByText("data").click();
    await expect(page.locator("#browse-list")).toContainText("table.csv");
    await page.locator("#browse-list").getByText("table.csv").click();
    await expect(page.locator("#connect-modal")).toBeHidden();
    await expect(page.locator("#status")).toContainText("3 rows");
    await expect(page.locator("#source-list")).toContainText("table.csv");

    // gs:// paths in the Web address connector use the same sign-in.
    await openLink(page, "gs://bucket/data/table.csv");
    await expect(page.locator("#status")).toContainText("3 rows");

    // The token went to the storage API as a header only, and is kept nowhere.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.authorization === `Bearer ${TOKEN}` && !r.url.includes(TOKEN))).toBe(true);
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(CLIENT_ID);

    // Signing out hides the bucket again.
    await page.click("#btn-connect");
    await page.click("[data-connector=gcs]");
    await page.click("#gcs-sign-out");
    await expect(page.locator("#gcs-sign-in")).toBeVisible();
    await expect(page.locator("#browse-bucket")).toBeHidden();
  } finally {
    await app.context.close();
    app.server.close();
  }
});

test("without the local server or a sign-in, gs:// paths explain themselves", async ({ browser }) => {
  const app = await openApp(browser);
  try {
    await openLink(app.page, "gs://bucket/table.parquet");
    await expect(app.page.locator("#status")).toContainText("need the local server");
  } finally {
    await app.context.close();
    app.server.close();
  }
});

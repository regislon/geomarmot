/* AttributeManager's table editor, end to end. */

import { test, expect } from "@playwright/test";
import { openApp } from "./app-target.js";
import { load, openGraph, selectNode } from "./support/workbench.js";

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

test("AttributeManager edits every attribute in one table, applied on OK", async () => {
  const { page } = app;
  await load(page, "gez.csv", "gez_name,gez_code,gez_abbrev,fid\nTropical,11,TAr,1\nBoreal,41,Ba,2\n");
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__gez.csv" } },
      { id: "n2", type: "AttributeManager", x: 320, y: 60, params: { actions: [] } },
    ],
    [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
  );
  await selectNode(page, "n2");
  await page.getByRole("button", { name: "Edit attributes…" }).click();
  const table = page.locator(".attribute-table tbody tr");
  await expect(table).toHaveCount(4);
  await expect(table.nth(0).locator("td").nth(4).locator("select")).toHaveValue("Do nothing");

  // Typing a name renames; Remove strikes a row; a value sets one; a new row creates one.
  await table.nth(1).locator(".attribute-output").fill("code");
  await expect(table.nth(1).locator("select").last()).toHaveValue("Rename");
  await table.nth(2).locator("select").last().selectOption("Remove");
  await table.nth(3).getByText("set a value").click();
  await table.nth(3).locator(".value-spec input").fill("7");
  await page.getByRole("button", { name: "+ Add attribute" }).click();
  await table.nth(4).locator(".attribute-output").fill("source");
  await table.nth(4).locator(".value-spec input").fill("FAO");

  // Cancel changes nothing; OK applies it all.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#table-head")).toContainText("gez_abbrev");
  await page.getByRole("button", { name: "Edit attributes…" }).click();
  await table.nth(2).locator("select").last().selectOption("Remove");
  await table.nth(1).locator(".attribute-output").fill("code");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".attribute-table-modal")).toBeHidden();
  await expect(page.locator("#table-head th")).toHaveText(["gez_name", "code", "fid"]);
  await expect(page.locator("#inspector .attribute-summary li")).toHaveText([
    "Rename gez_code → code",
    "Remove gez_abbrev",
  ]);
});

/*
 * An API key typed into the settings goes to the provider and nowhere else:
 * not into the autosave, a saved graph or its `custom` field, an export, the
 * generated transformers kept in IndexedDB, or the console.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fakeClaude, reply, text, toolUse } from "./support/fake-claude.js";
import { KEY, ask, assistantApp, csvOf } from "./support/assistant-app.js";

const SPEC = {
  id: "CustomAll",
  name: "All",
  summary: "Passes every row through unchanged, for this test.",
  description: "Everything.",
  inputs: [{ id: "input", label: "Input", description: "Rows." }],
  outputs: [{ id: "output", label: "Output", description: "The same rows.", from: "steps.all" }],
  params: [],
  steps: [
    {
      id: "all",
      kind: "sql",
      template: "SELECT * FROM {{inputs.input}}",
      transformer: "",
      inputs: [],
      params_json: "",
    },
  ],
};

test("the key reaches the provider and nothing else", async ({ browser }) => {
  const app = await assistantApp(browser, {
    csv: csvOf(["id", "lon", "lat"], [[1, 7.4, 46.9]]),
    nodes: [
      {
        id: "n2",
        type: "VertexCreator",
        x: 300,
        y: 60,
        params: {
          mode: "Replace with Point",
          x: { kind: "Attribute", column: "lon" },
          y: { kind: "Attribute", column: "lat" },
        },
      },
      { id: "n3", type: "Writer", x: 600, y: 60, params: { format: "GeoJSON", filename: "out" } },
    ],
    edges: [
      { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
      { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
    ],
  });
  const { page } = app;
  try {
    const requests = await fakeClaude(page, [
      reply([toolUse("propose_transformer", SPEC)]),
      reply([
        toolUse("propose_nodes", {
          nodes: [{ ref: "all", type: "CustomAll", params_json: "{}" }],
          edges: [{ from: "n2", fromPort: "output", to: "all", toPort: "input" }],
          replace_draft: true,
        }),
      ]),
      reply([text("Done.")]),
    ]);
    await ask(page, "pass it through");
    await page.click("#draft-apply");
    await expect(page.locator("#canvas .node-title")).toHaveCount(4);

    // It did go to the provider, as the API key header.
    expect(requests.every((r) => r.headers["x-api-key"] === KEY)).toBe(true);
    expect(requests.every((r) => !JSON.stringify(r.body).includes(KEY))).toBe(true);

    const autosave = await page.evaluate(() => localStorage.getItem("geomarmot:graph.v1"));
    expect(autosave).toContain("CustomAll");
    expect(autosave).not.toContain(KEY);

    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#btn-file").then(() => page.click("#menu-save-graph")),
    ]);
    const file = readFileSync(await saved.path(), "utf8");
    expect(JSON.parse(file).custom).toHaveLength(1);
    expect(file).not.toContain(KEY);

    await expect(page.locator("#btn-export")).toBeEnabled();
    const [exported] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export")]);
    expect(readFileSync(await exported.path(), "utf8")).not.toContain(KEY);

    const kept = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("geomarmot", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const all = open.result.transaction("custom").objectStore("custom").getAll();
            all.onsuccess = () => resolve(JSON.stringify(all.result));
          };
        }),
    );
    expect(kept).toContain("CustomAll");
    expect(kept).not.toContain(KEY);

    expect(app.console.join("\n")).not.toContain(KEY);
  } finally {
    await app.context.close();
    app.server.close();
  }
});

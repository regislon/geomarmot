/*
 * A generated transformer end to end: the assistant writes it, uses it in a
 * draft, the user applies it; it survives a reload, travels in a saved graph,
 * and exports as a transformer folder.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp } from "./app-target.js";
import { fakeClaude, reply, text, toolUse } from "./support/fake-claude.js";

const PEOPLE = "id,name,age\n1,Ann,34\n2,Bob,17\n3,Cy,61\n";

const SPEC = {
  id: "CustomAdults",
  name: "Adults",
  summary: "Keeps rows whose age is at least a threshold.",
  description: "Filters on an age column.",
  inputs: [{ id: "input", label: "Input", description: "Rows with an age." }],
  outputs: [{ id: "output", label: "Output", description: "Rows at or over the threshold.", from: "steps.keep" }],
  params: [
    {
      id: "age",
      label: "Age column",
      kind: "column",
      description: "The age column.",
      options: [],
      default_json: '"age"',
    },
    { id: "min", label: "Minimum", kind: "number", description: "The threshold.", options: [], default_json: "18" },
  ],
  steps: [
    {
      id: "keep",
      kind: "sql",
      template: "SELECT * FROM {{inputs.input}} WHERE {{params.age}} >= {{params.min}}",
      transformer: "",
      inputs: [],
      params_json: "",
    },
  ],
};

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

async function readerGraph(page) {
  await page.setInputFiles("#file-input", { name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(PEOPLE) });
  await expect(page.locator("#status")).toContainText("rows");
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "geomarmot-graph",
        version: 1,
        nodes: [{ id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__people.csv" } }],
        edges: [],
      }),
    ),
  });
  await expect(page.locator("#status")).toContainText(/nodes ready|Opened/);
}

test("the assistant writes a transformer, uses it, and the user applies and exports it", async () => {
  const { page } = app;
  await readerGraph(page);
  await page.click("#btn-assistant");
  await page.click("#assistant-settings");
  await page.fill("#ai-key", "sk-ant-test");
  await page.click("#ai-settings-save");
  const requests = await fakeClaude(page, [
    reply([toolUse("propose_transformer", SPEC)]),
    reply([
      toolUse("propose_nodes", {
        nodes: [{ ref: "adults", type: "CustomAdults", params_json: JSON.stringify({ min: 18 }) }],
        edges: [{ from: "n1", fromPort: "output", to: "adults", toPort: "input" }],
        replace_draft: true,
      }),
    ]),
    reply([toolUse("preview_draft", {})]),
    reply([text("Added an Adults filter.")]),
  ]);
  await page.fill("#assistant-input", "keep the adults");
  await page.click("#assistant-send");
  await expect(page.locator("#assistant-log")).toContainText("Added an Adults filter.");
  const accepted = JSON.parse(requests[1].body.messages.at(-1).content[0].content);
  expect(accepted).toMatchObject({ ok: true, nodes: ["CustomAdults"] });
  const preview = JSON.parse(requests[3].body.messages.at(-1).content[0].content);
  expect(preview.nodes[0]).toMatchObject({ type: "CustomAdults", state: "ok" });
  expect(preview.nodes[0].outputs[0].rows).toBe(2);

  await page.click("#draft-apply");
  await expect(page.locator("#palette button.generated")).toHaveText("CustomAdults");
  await expect(page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b2$/);

  // Export as folder: a tar holding index.js, README.md and tests.json.
  await page.click("#assistant-close");
  const box = await page.locator('[data-node="n2"] .node-title').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#inspector .badge.ai").first()).toHaveText("generated");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-folder")]);
  expect(download.suggestedFilename()).toBe("custom-adults.tar");
  const dir = mkdtempSync(join(tmpdir(), "gm-export-"));
  execFileSync("tar", ["-xf", await download.path(), "-C", dir]);
  const index = readFileSync(join(dir, "custom-adults/index.js"), "utf8");
  expect(index).toContain('id: "CustomAdults"');
  expect(index).toContain("renderTemplate");
  // It parses as a module (checked as .mjs: outside the repo there is no "type": "module").
  writeFileSync(join(dir, "check.mjs"), index);
  execFileSync("node", ["--check", join(dir, "check.mjs")]);
  expect(readFileSync(join(dir, "custom-adults/README.md"), "utf8")).toContain("## Limitations");
  const tests = JSON.parse(readFileSync(join(dir, "custom-adults/tests.json"), "utf8"));
  expect(tests.cases[0].expect.output.rows.map((row) => row[1])).toEqual(["Ann", "Cy"]);
  expect(index + JSON.stringify(tests)).not.toContain("sqlMode");

  // It survives a reload (kept in this browser, and in the autosave).
  await page.reload();
  await expect(page.locator("#status")).toContainText(/Restored|nodes ready/, { timeout: 90_000 });
  await expect(page.locator("#canvas .node-title")).toHaveText(["Reader", "CustomAdults"]);
  await expect(page.locator("#palette button.generated")).toHaveText("CustomAdults");

  // And a saved graph carries it to a browser that has never seen it.
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-save").then(() => page.click("#menu-save-computer")),
  ]);
  const file = JSON.parse(readFileSync(await saved.path(), "utf8"));
  expect(file.custom.map((c) => c.spec.id)).toEqual(["CustomAdults"]);
  const fresh = await openApp(page.context().browser());
  try {
    await fresh.page.setInputFiles("#file-input", {
      name: "people.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(PEOPLE),
    });
    await fresh.page.setInputFiles("#graph-input", {
      name: "g.flow.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(file)),
    });
    await expect(fresh.page.locator("#canvas .node-title")).toHaveText(["Reader", "CustomAdults"]);
    await expect(fresh.page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b2$/);
  } finally {
    await fresh.context.close();
    fresh.server.close();
  }
});

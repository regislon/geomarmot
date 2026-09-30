/*
 * Changing the data level mid-conversation (docs/security.md).
 *
 * Lowering it ends the provider conversation: nothing sent or received before
 * may reach the provider again, a request in flight is cancelled, and values
 * the assistant copied from data into params are redacted — through Apply,
 * reload, saving and opening. Raising it keeps the conversation.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { schemaFor } from "../../app/src/ai/gate/schemas.js";
import { validate } from "../../app/src/core/jsonschema.js";
import { fakeClaude, reply, text, toolUse } from "./support/fake-claude.js";
import { ask, assistantApp, csvOf, everythingSent, openingSummary, setLevel } from "./support/assistant-app.js";

const ROWS = Array.from({ length: 25 }, (_, k) => [k, `v-CANARY-${k}`, `${"q".repeat(10)}`]);
const CSV = csvOf(["id", "name", "note"], ROWS);

let app;
test.afterEach(async () => {
  await app?.context.close();
  app?.server.close();
});

/** Everything in one request, and its opening summary checked against level 1. */
function expectCleanAtLevel1(request) {
  expect(JSON.stringify(request.body)).not.toContain("CANARY");
  const summary = openingSummary(request);
  expect(summary).not.toBeNull();
  expect(validate(summary, schemaFor("graph", 1))).toEqual([]);
}

test("lowering from 3 to 1 starts over from the user's own messages and a level 1 summary", async ({ browser }) => {
  app = await assistantApp(browser, { csv: CSV, level: 3 });
  const { page } = app;
  const draft = {
    nodes: [
      {
        ref: "bad",
        type: "SQLTransformer",
        params_json: JSON.stringify({ sql: "SELECT * FROM input WHERE CAST(name AS INTEGER) > 0" }),
      },
    ],
    edges: [{ from: "n1", fromPort: "output", to: "bad", toPort: "input" }],
    replace_draft: true,
  };
  const requests = await fakeClaude(page, [
    reply([toolUse("inspect_node", { node: "n1" })]),
    reply([toolUse("propose_nodes", draft)]),
    reply([toolUse("preview_draft", {})]),
    reply([text("I saw v-CANARY-3 and an error quoting v-CANARY-0.")]),
    reply([text("Fresh start.")]),
  ]);
  await ask(page, "look at my data");
  // At level 3 the rows, the preview and the raw error did carry canaries: that was allowed then.
  expect(JSON.stringify(requests[3].body)).toContain("v-CANARY-3");

  await setLevel(page, 1);
  await expect(page.locator("#assistant-log")).toContainText("new conversation starts");
  await ask(page, "now just count them");
  const after = requests.at(-1);
  expectCleanAtLevel1(after);
  expect(after.body.messages).toHaveLength(1);
  const said = after.body.messages[0].content.map((b) => b.text).join("\n");
  expect(said).toContain("look at my data");
  expect(said).toContain("now just count them");
  // The chat still shows everything, marked as no longer sent.
  await expect(page.locator("#assistant-log .unsent").first()).toBeVisible();
});

test("a request in flight when the level is lowered is cancelled, and its reply never used", async ({ browser }) => {
  app = await assistantApp(browser, { csv: CSV, level: 3 });
  const { page } = app;
  const requests = await fakeClaude(page, [
    { delayMs: 2500, reply: reply([text("Late reply quoting v-CANARY-DELAYED.")]) },
    reply([text("After.")]),
  ]);
  await page.fill("#assistant-input", "slow question");
  await page.click("#assistant-send");
  await expect(page.locator("#assistant-stop")).toBeVisible();
  await setLevel(page, 1);
  await expect(page.locator("#assistant-send")).toBeEnabled();
  await page.waitForTimeout(3000);
  await expect(page.locator("#assistant-log")).not.toContainText("Late reply");
  await ask(page, "next question");
  await expect(page.locator("#assistant-log")).toContainText("After.");
  expectCleanAtLevel1(requests.at(-1));
  expect(everythingSent(requests.slice(1))).not.toContain("DELAYED");
});

test("a value copied from data into a param is redacted below its level, everywhere it goes", async ({ browser }) => {
  app = await assistantApp(browser, { csv: CSV, level: 3 });
  const { page } = app;
  const tester = {
    nodes: [
      {
        ref: "pick",
        type: "Tester",
        params_json: JSON.stringify({
          logic: "AND",
          conditions: [{ column: "name", operator: "=", value: "v-CANARY-7" }],
        }),
      },
    ],
    edges: [{ from: "n1", fromPort: "output", to: "pick", toPort: "input" }],
    replace_draft: true,
  };
  const spec = {
    id: "CustomPick",
    name: "Pick",
    summary: "Keeps the row named v-CANARY-8, as asked.",
    description: "Filters to v-CANARY-8.",
    inputs: [{ id: "input", label: "Input", description: "Rows." }],
    outputs: [{ id: "output", label: "Output", description: "The v-CANARY-8 row.", from: "steps.keep" }],
    params: [],
    steps: [
      {
        id: "keep",
        kind: "sql",
        template: "SELECT * FROM {{inputs.input}} WHERE name = 'v-CANARY-8'",
        transformer: "",
        inputs: [],
        params_json: "",
      },
    ],
  };
  const requests = await fakeClaude(page, [
    reply([toolUse("propose_nodes", tester), toolUse("propose_transformer", spec)]),
    reply([text("Draft ready.")]),
    reply([
      toolUse("get_graph", {}),
      toolUse("describe_transformer", { id: "CustomPick" }),
      toolUse("search_transformers", { query: "pick", limit: 5 }),
    ]),
    reply([text("Seen.")]),
    reply([text("Again.")]),
    reply([toolUse("get_graph", {})]),
    reply([text("And again.")]),
    reply([toolUse("get_graph", {})]),
    reply([text("Edited.")]),
  ]);
  /** The Tester as the latest get_graph result in a request showed it. */
  const testerIn = (request) => {
    const results = request.body.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const graph = JSON.parse(results.at(-1).content);
    return graph.nodes.find((n) => n.type === "Tester");
  };
  await ask(page, "keep row 7");
  await page.click("#draft-apply");
  await expect(page.locator("#canvas .node-title")).toHaveText(["Reader", "Tester"]);

  // Lowered to 1: the Tester value goes out redacted; the generated transformer shows no text.
  await setLevel(page, 1);
  await ask(page, "what is in my graph?");
  const [, , , toolRound] = requests;
  for (const request of [requests[2], toolRound]) expect(JSON.stringify(request.body)).not.toContain("CANARY");
  const results = toolRound.body.messages.at(-1).content.map((b) => JSON.parse(b.content));
  const described = results.find((r) => r.id === "CustomPick");
  expect(described.id).toBe("CustomPick");
  expect(described.summary).toMatch(/higher data level/);
  const summary = openingSummary(requests[2]);
  const node = summary.nodes.find((n) => n.type === "Tester");
  expect(node.params.conditions[0].value).toEqual({
    redacted: "derived from data above the current level",
    kind: "string",
  });
  expect(node.params.conditions[0].column).toBe("name");

  // After a reload: the origin survived the autosave.
  await page.reload();
  await expect(page.locator("#status")).toContainText(/Restored|nodes ready/, { timeout: 90_000 });
  await page.setInputFiles("#file-input", { name: "data.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.click("#btn-assistant");
  await ask(page, "and now?");
  expectCleanAtLevel1(requests[4]);

  // After saving the graph to a file and opening it again.
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export-graph")]);
  const file = readFileSync(await download.path(), "utf8");
  await page.setInputFiles("#graph-input", {
    name: "saved.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(file),
  });
  await ask(page, "once more");
  expect(JSON.stringify(requests[6].body)).not.toContain("CANARY");
  expect(testerIn(requests[6]).params.conditions[0].value).toMatchObject({ redacted: expect.any(String) });

  // The user edits the value: it is theirs now, and it is sent.
  await page.click("#assistant-close");
  const box = await page.locator('[data-node="n2"] .node-title').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#inspector .repeat-row input[placeholder="value"]').fill("Bern");
  await page.waitForTimeout(600);
  await page.click("#btn-assistant");
  await ask(page, "edited");
  const edited = requests[8];
  expect(JSON.stringify(edited.body)).not.toContain("CANARY");
  expect(testerIn(edited).params.conditions[0].value).toBe("Bern");
});

test("raising the level keeps the conversation as it was", async ({ browser }) => {
  app = await assistantApp(browser, { csv: CSV, level: 1 });
  const { page } = app;
  const requests = await fakeClaude(page, [reply([text("One.")]), reply([text("Two.")])]);
  await ask(page, "first");
  await setLevel(page, 3);
  await ask(page, "second");
  expect(requests[1].body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(requests[1].body.messages[0]).toEqual(requests[0].body.messages[0]);
});

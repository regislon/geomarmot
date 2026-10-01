/*
 * The assistant, end to end against a scripted Messages API: tools, the
 * draft, Apply, and what leaves the browser.
 */

import { test, expect } from "@playwright/test";
import { openApp } from "./app-target.js";
import { everythingSent, fakeClaude, reply, text, toolUse } from "./support/fake-claude.js";

const SWISS = "city,E,N\nBernCANARY,2600000,1200000\nZugCANARY,2681000,1224000\n";
const KEY = "sk-ant-test-key-for-fake-api";

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

async function setUp(page, level = 1) {
  await page.setInputFiles("#file-input", { name: "swiss.csv", mimeType: "text/csv", buffer: Buffer.from(SWISS) });
  await expect(page.locator("#status")).toContainText("rows");
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "geomarmot-graph",
        version: 1,
        nodes: [{ id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__swiss.csv" } }],
        edges: [],
      }),
    ),
  });
  await expect(page.locator("#status")).toContainText(/nodes ready|Opened/);
  await page.click("#btn-assistant");
  await page.click("#assistant-settings");
  await page.fill("#ai-key", KEY);
  await page.check(`input[name="ai-level"][value="${level}"]`);
  await page.click("#ai-settings-save");
}

async function ask(page, message) {
  await page.fill("#assistant-input", message);
  await page.click("#assistant-send");
}

const POINTS = {
  nodes: [
    {
      ref: "pts",
      type: "VertexCreator",
      params_json: JSON.stringify({
        mode: "Replace with Point",
        x: { kind: "Attribute", column: "E" },
        y: { kind: "Attribute", column: "N" },
      }),
    },
    { ref: "crs", type: "CoordinateSystemSetter", params_json: JSON.stringify({ crs: "EPSG:2056" }) },
  ],
  edges: [
    { from: "n1", fromPort: "output", to: "pts", toPort: "input" },
    { from: "pts", fromPort: "output", to: "crs", toPort: "input" },
  ],
  replace_draft: true,
};

test("points from an Excel-style table: get_graph, propose, Apply", async () => {
  const { page } = app;
  await setUp(page);
  const requests = await fakeClaude(page, [
    reply([text("Let me look."), toolUse("get_graph", {})]),
    reply([toolUse("propose_nodes", POINTS)]),
    reply([toolUse("preview_draft", {})]),
    reply([text("A draft makes points from E/N in Swiss coordinates.")]),
  ]);
  await ask(page, "create points from this file");
  await expect(page.locator("#draft-bar")).toContainText("VertexCreator");
  await expect(page.locator("#assistant-log")).toContainText("A draft makes points");

  // Nothing in the graph until Apply.
  await expect(page.locator("#canvas .node-title")).toHaveCount(1);
  await page.click("#draft-apply");
  await expect(page.locator("#canvas .node-title")).toHaveText(["Reader", "VertexCreator", "CoordinateSystemSetter"]);
  await expect(page.locator("#draft-bar")).toHaveCount(0);

  // The request: Claude Opus 5.5, strict tools, the user's key in the browser.
  const first = requests[0];
  expect(first.body.model).toBe("claude-opus-5-5");
  expect(first.body.tools.every((t) => t.strict === true)).toBe(true);
  expect(first.body.tool_choice).toEqual({ type: "auto" });
  expect(first.headers["x-api-key"]).toBe(KEY);
  // The summary of the graph went out; the city values did not.
  expect(JSON.stringify(first.body)).toContain('\\"name\\":\\"E\\"');
  expect(everythingSent(requests)).not.toContain("CANARY");
  // The preview ran the draft on the sample, in its own engine, and reported it at level 1.
  const preview = JSON.parse(requests[3].body.messages.at(-1).content[0].content);
  const crs = preview.nodes.find((n) => n.type === "CoordinateSystemSetter");
  expect(crs).toMatchObject({ state: "ok", draft: true });
  expect(crs.outputs[0]).toMatchObject({ port: "output", rows: 2, crs: "EPSG:2056" });
  expect(crs.outputs[0].sample).toBeUndefined();

  // One undo removes the whole draft.
  await page.click("#btn-undo");
  await expect(page.locator("#canvas .node-title")).toHaveCount(1);
});

test("a proposal with a Reader, bad params or forbidden SQL is refused whole", async () => {
  const { page } = app;
  await setUp(page);
  const bad = {
    nodes: [
      { ref: "r", type: "Reader", params_json: "{}" },
      { ref: "t", type: "Tester", params_json: JSON.stringify({ logic: "XOR" }) },
      {
        ref: "q",
        type: "SQLTransformer",
        params_json: JSON.stringify({ sql: "SELECT * FROM read_csv('/etc/passwd')" }),
      },
      { ref: "m", type: "Tester", params_json: JSON.stringify({ sqlMode: "unrestricted" }) },
    ],
    edges: [],
    replace_draft: true,
  };
  const requests = await fakeClaude(page, [reply([toolUse("propose_nodes", bad)]), reply([text("Sorry.")])]);
  await ask(page, "do something");
  await expect(page.locator("#assistant-log")).toContainText("Sorry.");
  await expect(page.locator("#draft-bar")).toHaveCount(0);
  const result = JSON.parse(requests[1].body.messages.at(-1).content[0].content);
  expect(result.ok).toBe(false);
  const codes = result.problems.map((p) => `${p.node}:${p.error.code}`);
  expect(codes).toEqual(["r:NOT_AI_USABLE", "t:INVALID_PARAMS", "q:SQL_FORBIDDEN_CONSTRUCT", "m:INVALID_PARAMS"]);
  expect(requests[1].body.messages.at(-1).content[0].is_error).toBe(true);
});

test("the assistant can add a Writer; nothing is written until Run", async () => {
  const { page } = app;
  await setUp(page);
  const downloads = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const writer = {
    nodes: [{ ref: "out", type: "Writer", params_json: JSON.stringify({ format: "CSV", filename: "swiss" }) }],
    edges: [{ from: "n1", fromPort: "output", to: "out", toPort: "input" }],
    replace_draft: true,
  };
  await fakeClaude(page, [reply([toolUse("propose_nodes", writer)]), reply([text("Click Run to write it.")])]);
  await ask(page, "add a csv writer");
  await expect(page.locator("#assistant-log")).toContainText("Click Run");
  await page.click("#draft-apply");
  await expect(page.locator("#canvas .node-title")).toHaveText(["Reader", "Writer"]);
  await expect(page.locator("#btn-export")).toBeEnabled();
  expect(downloads).toEqual([]);
});

test("a refusal is shown, and the conversation stays usable", async () => {
  const { page } = app;
  await setUp(page);
  const requests = await fakeClaude(page, [
    reply([], { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "" } }),
    reply([text("Hello again.")]),
  ]);
  await ask(page, "first");
  await expect(page.locator("#assistant-log")).toContainText("declined this request (cyber)");
  await ask(page, "second");
  await expect(page.locator("#assistant-log")).toContainText("Hello again.");
  expect(requests[1].body.fallbacks).toBe("default");
});

test("an API error is reported without losing the message box", async () => {
  const { page } = app;
  await setUp(page);
  await fakeClaude(page, [
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
  ]);
  await ask(page, "hi");
  await expect(page.locator("#assistant-log .chat-msg.error")).toContainText("API key was refused");
  await expect(page.locator("#assistant-send")).toBeEnabled();
});

test("OpenAI: tool calls go through the Responses API, with reasoning items sent back", async () => {
  const { page } = app;
  await setUp(page);
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  const json = { ...CORS, "content-type": "application/json" };
  const sent = [];
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
  await page.route("https://api.openai.com/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (request.url().endsWith("/models"))
      return route.fulfill({
        headers: json,
        body: JSON.stringify({ object: "list", data: [{ id: "gpt-test", object: "model", created: 1 }] }),
      });
    sent.push({ url: request.url(), body: request.postDataJSON() });
    const output =
      sent.length === 1
        ? [reasoning, { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_graph", arguments: "{}" }]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Your graph has one Reader." }],
            },
          ];
    return route.fulfill({
      headers: json,
      body: JSON.stringify({
        id: `resp_${sent.length}`,
        object: "response",
        status: "completed",
        model: "gpt-test",
        output,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
  });
  await page.click("#assistant-settings");
  await page.check('input[name="ai-provider"][value="openai"]');
  await page.fill("#ai-key", "sk-openai-test");
  await page.locator("#ai-key").blur();
  await expect(page.locator("#ai-model")).toHaveValue("gpt-test");
  await page.click("#ai-settings-save");
  await ask(page, "what is in my graph?");
  await expect(page.locator("#assistant-log")).toContainText("Your graph has one Reader.");

  expect(sent.every((r) => r.url.endsWith("/v1/responses"))).toBe(true);
  expect(sent[0].body).toMatchObject({ model: "gpt-test", store: false, tool_choice: "auto" });
  expect(sent[0].body.tools.every((t) => t.type === "function" && t.strict === true)).toBe(true);
  const second = sent[1].body.input;
  expect(second).toContainEqual(reasoning);
  expect(second).toContainEqual({ type: "function_call", call_id: "call_1", name: "get_graph", arguments: "{}" });
  expect(second.find((item) => item.type === "function_call_output")).toMatchObject({ call_id: "call_1" });
  expect(JSON.stringify(sent)).not.toContain("CANARY");
});

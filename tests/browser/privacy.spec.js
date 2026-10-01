/*
 * What leaves the browser at each data level (docs/security.md, plan PR 29).
 *
 * Two kinds of check on every conversation: shape — every tool result and the
 * opening summary validate against that level's gate schema — and forbidden
 * disclosure — canaries placed so that the path under test is the only way
 * they could get out never appear in anything sent. Each path is also checked
 * to send what it should, so the gate cannot pass by blocking everything.
 */

import { test, expect } from "@playwright/test";
import { schemaFor } from "../../app/src/ai/gate/schemas.js";
import { ERROR_CATALOGUE } from "../../app/src/ai/gate/errors.js";
import { validate } from "../../app/src/core/jsonschema.js";
import { fakeClaude, reply, text, toolUse } from "./support/fake-claude.js";
import {
  PAYLOAD_TYPE,
  ask,
  assistantApp,
  csvOf,
  everythingSent,
  openingSummary,
  toolResults,
} from "./support/assistant-app.js";

let app;
test.afterEach(async () => {
  await app?.context.close();
  app?.server.close();
});

/** Every tool result and opening summary validates against its level's schema. */
function expectShape(requests, level) {
  for (const result of toolResults(requests)) {
    const type = result.isError && !result.name?.startsWith("propose_") ? "error" : PAYLOAD_TYPE[result.name];
    const problems = validate(result.payload, schemaFor(type, level));
    expect(problems, `${result.name} as ${type} at level ${level}`).toEqual([]);
  }
  for (const request of requests) {
    const summary = openingSummary(request);
    if (summary) expect(validate(summary, schemaFor("graph", level)), "opening summary").toEqual([]);
  }
}

const draft = (nodes, edges) => ({ nodes, edges, replace_draft: true });
const sqlNode = (ref, sql) => ({ ref, type: "SQLTransformer", params_json: JSON.stringify({ sql }) });
const fromReader = (to) => ({ from: "n1", fromPort: "output", to, toPort: "input" });

/* ---------- levels 1 and 2: errors are structured ---------- */

const ERROR_GRAPH = {
  nodes: [
    {
      id: "n2",
      type: "AttributeCreator",
      x: 0,
      y: 0,
      params: { mode: "SQL query", sql: "SELECT *, nosuch + 1 AS x FROM input" },
    },
    { id: "n3", type: "Tester", x: 0, y: 0, params: {} },
    { id: "n4", type: "CoordinateSystemSetter", x: 0, y: 0, params: { crs: "EPSG:999999" } },
    { id: "n5", type: "Sorter", x: 0, y: 0, params: {} },
    { id: "n6", type: "SQLTransformer", x: 0, y: 0, params: { sql: "SELECT * FROM read_csv('/etc/passwd')" } },
  ],
  edges: [
    { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
    { id: "e2", from: "n1", fromPort: "output", to: "n4", toPort: "input" },
    { id: "e3", from: "n2", fromPort: "output", to: "n5", toPort: "input" },
    { id: "e4", from: "n1", fromPort: "output", to: "n6", toPort: "input" },
  ],
};

for (const level of [1, 2]) {
  test(`level ${level}: every error goes out as a catalogue code, never as text`, async ({ browser }) => {
    // Level 1 has no data path, so every cell carries a canary. Level 2 sends statistics, so there the
    // canaries are unique values strictly between min and max, never among the top 5 — and they come
    // first, so they are the values a conversion error quotes.
    const rows =
      level === 1
        ? Array.from({ length: 30 }, (_, k) => [k, `CANARY-E${k}-${"é".repeat(k % 3)}`, `city CANARY-C${k}`])
        : [
            ...["m-CANARY-1", "m-CANARY-2", "m-CANARY-3"].map((name, k) => [k, name, "c"]),
            ...["aaa", "bbb", "zzz"].flatMap((name) => Array(10).fill(name)).map((name, k) => [k + 3, name, "c"]),
            ...["ccc", "yyy"].flatMap((name) => Array(5).fill(name)).map((name, k) => [k + 33, name, "c"]),
          ];
    app = await assistantApp(browser, { csv: csvOf(["id", "name", "city"], rows), level, ...ERROR_GRAPH });
    const { page } = app;
    const requests = await fakeClaude(page, [
      reply([toolUse("get_graph", {}), toolUse("search_transformers", { query: "filter rows", limit: 3 })]),
      reply(["n1", "n2", "n3", "n4", "n5", "n6", "n99"].map((node) => toolUse("inspect_node", { node }))),
      reply([toolUse("inspect_node", { node: 5 }), toolUse("describe_transformer", { ids: ["Nope"] })]),
      reply([
        toolUse(
          "propose_nodes",
          draft([sqlNode("bad", "SELECT * FROM input WHERE CAST(name AS INTEGER) > 0")], [fromReader("bad")]),
        ),
      ]),
      reply([toolUse("preview_draft", {})]),
      reply([toolUse("ask_user", { question: "Which column?", choices: ["name", "city"] })]),
      reply([text("Done.")]),
    ]);
    await page.fill("#assistant-input", "check my graph");
    await page.click("#assistant-send");
    await page.locator("#assistant-log").getByRole("button", { name: "city" }).click();
    await expect(page.locator("#assistant-log")).toContainText("Done.");

    expect(everythingSent(requests)).not.toContain("CANARY");
    // The raw error did quote a canary: the chat keeps it, locally.
    await expect(page.locator("#assistant-log")).toContainText("CANARY");
    expectShape(requests, level);
    const errors = toolResults(requests)
      .flatMap((r) => [r.payload.error, ...(r.payload.nodes || [r.payload]).map((n) => n?.error)])
      .filter(Boolean);
    const codes = new Set(errors.map((e) => e.code));
    for (const code of [
      "COLUMN_NOT_FOUND",
      "PORT_NOT_CONNECTED",
      "CRS_UNKNOWN",
      "UPSTREAM_ERROR",
      "SQL_FORBIDDEN_CONSTRUCT",
      "UNKNOWN_NODE",
      "INVALID_INPUT",
      "CONVERSION_FAILED",
    ]) {
      expect(codes, code).toContain(code);
    }
    for (const error of errors) {
      expect(Object.keys(error).sort(), error.code).toEqual(["code", "message", "params"]);
      expect(error.message).toBe(ERROR_CATALOGUE[error.code].message(error.params));
    }
    // The user's own answer is theirs to send.
    expect(toolResults(requests).find((r) => r.name === "ask_user").payload).toEqual({ answer: "city" });
  });
}

/* ---------- level 2: aggregates ---------- */

test("level 2: statistics leave, values outside them do not", async ({ browser }) => {
  const frequent = [
    ...Array(20).fill("alpha"),
    ...Array(15).fill("beta"),
    ...Array(10).fill("gamma"),
    ...Array(6).fill("delta"),
    ...Array(5).fill("epsilon"),
  ];
  const cats = [...frequent, "c-CANARY-1", "c-CANARY-2", "c-CANARY-3", "c-CANARY-4"];
  const long = `${"x".repeat(100)}CANARY-B`;
  const extra = Array.from({ length: 45 }, (_, k) => `c${k + 1}`);
  const rows = cats.map((cat, k) => [k, cat, long, ...extra.map((c) => (c === "c45" ? `CANARY-C${k}` : k % 3))]);
  app = await assistantApp(browser, { csv: csvOf(["id", "cat", "note", ...extra], rows), level: 2 });
  const { page } = app;
  const requests = await fakeClaude(page, [reply([toolUse("inspect_node", { node: "n1" })]), reply([text("Seen.")])]);
  await ask(page, "profile it");

  expect(everythingSent(requests)).not.toContain("CANARY");
  expectShape(requests, 2);
  const stats = toolResults(requests)[0].payload.outputs[0].stats;
  const cat = stats.find((s) => s.name === "cat");
  expect(cat.min).toBe("alpha");
  expect(cat.max).toBe("gamma");
  expect(cat.top.map((t) => t.value)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
  expect(stats.find((s) => s.name === "note").top[0].value).toHaveLength(100);
  expect(stats.map((s) => s.name)).not.toContain("c45");
  expect(toolResults(requests)[0].payload.outputs[0].sample).toBeUndefined();
});

/* ---------- level 3: rows, previews and raw errors, within limits ---------- */

/** 40 rows: the first 20 safe, apart from a canary past character 200; canaries in rows 21 onwards. */
function rowsForLevel3() {
  return Array.from({ length: 40 }, (_, k) => {
    const name = k < 20 ? `${k % 2 ? "z" : "a"}-row-${String(k).padStart(2, "0")}` : `n-CANARY-S${k}`;
    return [k, name, `${String(k).padStart(3, "0")}${"y".repeat(197)}CANARY-L${k}`];
  });
}

test("level 3: at most 20 sample rows, cut to 200 characters", async ({ browser }) => {
  app = await assistantApp(browser, { csv: csvOf(["id", "name", "long"], rowsForLevel3()), level: 3 });
  const { page } = app;
  const requests = await fakeClaude(page, [reply([toolUse("inspect_node", { node: "n1" })]), reply([text("Seen.")])]);
  await ask(page, "show me rows");

  expect(everythingSent(requests)).not.toContain("CANARY");
  expectShape(requests, 3);
  const sample = toolResults(requests)[0].payload.outputs[0].sample;
  expect(sample.rows).toHaveLength(20);
  expect(sample.rows.map((row) => row[1])).toEqual(
    rowsForLevel3()
      .slice(0, 20)
      .map((row) => row[1]),
  );
  expect(sample.rows[0][2]).toHaveLength(200);
});

test("level 3: preview rows follow the same limits", async ({ browser }) => {
  app = await assistantApp(browser, { csv: csvOf(["id", "name", "long"], rowsForLevel3()), level: 3 });
  const { page } = app;
  const requests = await fakeClaude(page, [
    reply([
      toolUse("propose_nodes", draft([{ ref: "keep", type: "Tester", params_json: "{}" }], [fromReader("keep")])),
    ]),
    reply([toolUse("preview_draft", {})]),
    reply([text("Previewed.")]),
  ]);
  await ask(page, "preview a filter");

  expect(everythingSent(requests)).not.toContain("CANARY");
  expectShape(requests, 3);
  const passed = toolResults(requests).find((r) => r.name === "preview_draft").payload.nodes[0].outputs[0];
  expect(passed.sample.rows).toHaveLength(20);
  expect(passed.sample.rows[0][2]).toHaveLength(200);
});

test("level 3: raw error text leaves, cut to 500 characters", async ({ browser }) => {
  const rows = [[1, `${"w".repeat(600)}CANARY-E`, "x"]];
  app = await assistantApp(browser, { csv: csvOf(["id", "name", "city"], rows), level: 3 });
  const { page } = app;
  const requests = await fakeClaude(page, [
    reply([
      toolUse(
        "propose_nodes",
        draft([sqlNode("bad", "SELECT * FROM input WHERE CAST(name AS INTEGER) > 0")], [fromReader("bad")]),
      ),
    ]),
    reply([toolUse("preview_draft", {})]),
    reply([text("It fails.")]),
  ]);
  await ask(page, "why does it fail");

  expect(everythingSent(requests)).not.toContain("CANARY");
  expectShape(requests, 3);
  const error = toolResults(requests).find((r) => r.name === "preview_draft").payload.error;
  expect(error.code).toBe("CONVERSION_FAILED");
  expect(error.raw).toMatch(/Conversion Error/);
  expect(error.raw.length).toBeLessThanOrEqual(500);
});

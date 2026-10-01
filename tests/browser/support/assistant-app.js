/*
 * The real app with a CSV, a graph and the assistant set to a data level, plus
 * readers for what was sent: every tool result with the payload type it was
 * gated as, and the graph summary a conversation starts with.
 */

import { expect } from "@playwright/test";
import { openApp } from "../app-target.js";

export const KEY = "sk-ant-test-key-leakcheck-7f41";

/** Payload type each tool's results are gated as (app/src/ai/gate/schemas.js). */
export const PAYLOAD_TYPE = {
  search_transformers: "search",
  describe_transformer: "transformers",
  get_graph: "graph",
  inspect_node: "node",
  propose_nodes: "proposal",
  propose_transformer: "proposal",
  preview_draft: "preview",
  ask_user: "answer",
};

export async function assistantApp(browser, { csv, name = "data.csv", nodes = [], edges = [], level = 1 }) {
  const app = await openApp(browser);
  const { page } = app;
  app.console = [];
  page.on("console", (message) => app.console.push(message.text()));
  await page.setInputFiles("#file-input", { name, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.locator("#status")).toContainText("rows");
  const reader = { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: `s1__${name}` } };
  await openGraph(page, [reader, ...nodes], edges);
  await page.click("#btn-assistant");
  await setLevel(page, level, { key: KEY });
  return app;
}

export async function openGraph(page, nodes, edges) {
  const file = { format: "geomarmot-graph", version: 1, nodes, edges };
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator("#status")).toContainText(/nodes ready|Opened|not connected|needs|PROJ|Blocked|error|not/i);
}

export async function setLevel(page, level, { key } = {}) {
  if (await page.locator("#assistant").isHidden()) await page.click("#btn-assistant");
  await page.click("#assistant-settings");
  if (key) await page.fill("#ai-key", key);
  await page.check(`input[name="ai-level"][value="${level}"]`);
  await page.click("#ai-settings-save");
  await expect(page.locator("#assistant-level")).toHaveText(`level ${level}`);
}

/** Send a message and wait until the assistant has finished with it. */
export async function ask(page, message) {
  await page.fill("#assistant-input", message);
  await page.click("#assistant-send");
  await expect(page.locator("#assistant-send")).toBeEnabled({ timeout: 30_000 });
}

/** Every tool result in the recorded requests, once each, with its tool's name. */
export function toolResults(requests) {
  const names = new Map();
  const seen = new Map();
  for (const { body } of requests) {
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_use") names.set(block.id, block.name);
        if (block.type === "tool_result" && !seen.has(block.tool_use_id)) {
          seen.set(block.tool_use_id, {
            name: names.get(block.tool_use_id),
            payload: JSON.parse(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
    }
  }
  return [...seen.values()];
}

/** The graph summary that opens a conversation, from the first user message of a request. */
export function openingSummary(request) {
  const first = request.body.messages[0].content.find((block) => block.text?.startsWith("The graph as it stands"));
  return first ? JSON.parse(first.text.slice(first.text.indexOf("\n") + 1)) : null;
}

/** Everything the page sent to the provider, as one string. */
export const everythingSent = (requests) =>
  requests.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join("\n");

/** A CSV from column names and rows. */
export function csvOf(columns, rows) {
  const cell = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  return [columns.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\n") + "\n";
}

/*
 * Regenerate the README screenshots from the built app:  npm run build && node scripts/screenshots.js
 *
 * docs/img/workbench.png  a small graph, its table and its map
 * docs/img/assistant.png  the assistant with a draft to apply (a scripted conversation; no key needed)
 */

import { chromium } from "@playwright/test";
import { serve } from "../tests/harness/serve.js";
import { fakeClaude, reply, text, toolUse } from "../tests/browser/support/fake-claude.js";

const CITIES = [
  "city,E,N,population",
  "Bern,2600667,1199657,134591",
  "Zürich,2683141,1247909,421878",
  "Geneva,2500317,1117896,203856",
  "Basel,2611283,1267323,173863",
  "Lausanne,2538005,1152483,140202",
  "Lugano,2717552,1095879,62315",
  "St. Gallen,2746182,1254491,76090",
  "Lucerne,2666228,1211597,82257",
].join("\n");

const GRAPH = {
  format: "geomarmot-graph",
  version: 1,
  nodes: [
    { id: "n1", type: "Reader", x: 40, y: 40, params: { sourceId: "s1__swiss_cities.csv" } },
    {
      id: "n2",
      type: "VertexCreator",
      x: 270,
      y: 40,
      params: {
        mode: "Replace with Point",
        x: { kind: "Attribute", column: "E" },
        y: { kind: "Attribute", column: "N" },
      },
    },
    { id: "n3", type: "CoordinateSystemSetter", x: 500, y: 40, params: { crs: "EPSG:2056" } },
    {
      id: "n4",
      type: "Tester",
      x: 730,
      y: 40,
      params: { logic: "AND", conditions: [{ column: "population", operator: ">", value: "100000" }] },
    },
  ],
  edges: [
    { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
    { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
    { id: "e3", from: "n3", fromPort: "output", to: "n4", toPort: "input" },
  ],
};

async function openApp(browser, server) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${server.url}/`);
  await page.waitForFunction(
    () => /Drop a file|nodes ready/.test(document.getElementById("status")?.textContent || ""),
    null,
    { timeout: 90_000 },
  );
  await page.setInputFiles("#file-input", {
    name: "swiss_cities.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CITIES),
  });
  await page.waitForFunction(() => /rows/.test(document.getElementById("status")?.textContent || ""));
  return page;
}

async function select(page, id) {
  const box = await page.locator(`[data-node="${id}"] .node-title`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const server = await serve({ root: "dist" });
const browser = await chromium.launch();
try {
  // The workbench.
  let page = await openApp(browser, server);
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(GRAPH)),
  });
  await page.waitForFunction(() => document.querySelectorAll("#canvas .port-count").length >= 4);
  await select(page, "n3");
  await page.waitForFunction(() => /features/.test(document.getElementById("map-status")?.textContent || ""));
  await page.waitForTimeout(2500); // basemap tiles, when the network allows
  await page.screenshot({ path: "docs/img/workbench.png" });
  await page.close();

  // The assistant, with a draft to apply.
  page = await openApp(browser, server);
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...GRAPH, nodes: GRAPH.nodes.slice(0, 1), edges: [] })),
  });
  await fakeClaude(page, [
    reply([text("Let me look at the table."), toolUse("get_graph", {})]),
    reply([
      toolUse("propose_nodes", {
        nodes: [
          {
            ref: "points",
            type: "VertexCreator",
            params_json: JSON.stringify({
              mode: "Replace with Point",
              x: { kind: "Attribute", column: "E" },
              y: { kind: "Attribute", column: "N" },
            }),
          },
          { ref: "swiss", type: "CoordinateSystemSetter", params_json: JSON.stringify({ crs: "EPSG:2056" }) },
        ],
        edges: [
          { from: "n1", fromPort: "output", to: "points", toPort: "input" },
          { from: "points", fromPort: "output", to: "swiss", toPort: "input" },
        ],
        replace_draft: true,
      }),
    ]),
    reply([toolUse("preview_draft", {})]),
    reply([
      text(
        "E and N are Swiss LV95 coordinates, so the draft builds a point from them and marks the points as EPSG:2056. " +
          "The preview gives 8 points. Apply it to add the two nodes.",
      ),
    ]),
  ]);
  await page.click("#btn-assistant");
  await page.click("#assistant-settings");
  await page.fill("#ai-key", "sk-ant-screenshot");
  await page.click("#ai-settings-save");
  await page.fill("#assistant-input", "Create points from this file");
  await page.click("#assistant-send");
  await page.waitForSelector("#draft-apply");
  await page.waitForFunction(() => !document.getElementById("assistant-send").disabled);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/img/assistant.png" });
} finally {
  await browser.close();
  server.close();
}
console.log("Wrote docs/img/workbench.png and docs/img/assistant.png");

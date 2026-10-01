/*
 * The workbench, end to end: linking ports, undo/redo, the inspector, saving
 * and autosave, help, the map, the feature geometry panel, and the SQL mode.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openApp } from "./app-target.js";

const CITIES = "city,lon,lat,pop\nBern,7.44,46.95,134000\nZug,8.52,47.17,30000\nLugano,8.95,46.0,63000\n";
const SWISS = "city,E,N\nBern,2600000,1200000\nZug,2681000,1224000\n";
const graphFile = (nodes, edges) =>
  Buffer.from(JSON.stringify({ format: "geomarmot-graph", version: 1, nodes, edges }));
const attr = (column) => ({ kind: "Attribute", column });

let app;
test.beforeEach(async ({ browser }) => {
  app = await openApp(browser);
});
test.afterEach(async () => {
  await app.context.close();
  app.server.close();
});

async function load(page, name, text) {
  await page.setInputFiles("#file-input", { name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await expect(page.locator("#status")).toContainText("rows");
}

async function openGraph(page, nodes, edges) {
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: graphFile(nodes, edges),
  });
  await expect(page.locator("#status")).toContainText(/nodes ready|Opened|needs a connection|is not connected/);
}

/** Select a node. By position: selecting redraws the canvas, so an element handle would go stale mid-click. */
async function selectNode(page, id) {
  const title = page.locator(`[data-node="${id}"] .node-title`);
  const type = await title.textContent();
  // A click can land while the canvas redraws: confirm it took, and click again if not.
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await title.boundingBox();
    // Near the left edge: a node far right can run under the inspector, which then takes the click.
    await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + box.height / 2);
    try {
      await expect(page.locator("#inspector h3")).toHaveText(type, { timeout: 2000 });
      return;
    } catch {
      /* try again */
    }
  }
  throw new Error(`Could not select ${id}`);
}

async function drag(page, from, to) {
  const a = await page.locator(from).boundingBox();
  const b = await page.locator(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("link two nodes by dragging port to port; undo and redo", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__cities.csv" } },
      {
        id: "n2",
        type: "Tester",
        x: 360,
        y: 60,
        params: { logic: "AND", conditions: [{ column: "pop", operator: ">", value: "50000" }] },
      },
    ],
    [],
  );
  await expect(page.locator('[data-node="n2"] .port-count')).toHaveCount(0);
  await drag(page, '[data-node="n1"][data-port="output"].port-out', '[data-node="n2"][data-port="input"]');
  await expect(page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b2$/);
  await page.click("#btn-undo");
  await expect(page.locator('[data-node="n2"] .port-count')).toHaveCount(0);
  await page.click("#btn-redo");
  await expect(page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b2$/);
});

test("editing a parameter in the inspector changes the output", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__cities.csv" } },
      {
        id: "n2",
        type: "Tester",
        x: 360,
        y: 60,
        params: { logic: "AND", conditions: [{ column: "pop", operator: ">", value: "50000" }] },
      },
    ],
    [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
  );
  await expect(page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b2$/);
  await selectNode(page, "n2");
  const value = page.locator('#inspector .repeat-row input[placeholder="value"]');
  await value.fill("100000");
  await expect(page.locator('[data-node="n2"] .port-count').first()).toHaveText(/\b1$/);
});

test("save graph downloads the geomarmot format; autosave restores the canvas after a reload", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(page, [{ id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__cities.csv" } }], []);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export-graph")]);
  const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(saved.format).toBe("geomarmot-graph");
  expect(saved.nodes.map((n) => n.type)).toEqual(["Reader"]);
  await page.reload();
  await expect(page.locator("#canvas .node-title")).toHaveText(["Reader"]);
});

test("the ? button opens a transformer's help", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(page, [{ id: "n1", type: "AttributeCreator", x: 40, y: 60, params: {} }], []);
  await selectNode(page, "n1");
  await page.click("#inspector .help-btn");
  await expect(page.locator("#help-modal")).toBeVisible();
  await expect(page.locator("#help-body")).toContainText("input");
});

test("the map draws points, refuses coordinates that are not lon/lat, and draws them once labelled", async () => {
  const { page } = app;
  await load(page, "swiss.csv", SWISS);
  const points = { mode: "Replace with Point", x: attr("E"), y: attr("N") };
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__swiss.csv" } },
      { id: "n2", type: "VertexCreator", x: 320, y: 60, params: points },
      { id: "n3", type: "CoordinateSystemSetter", x: 600, y: 60, params: { crs: "EPSG:2056" } },
    ],
    [
      { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
      { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
    ],
  );
  await selectNode(page, "n2");
  await expect(page.locator("#map-status")).toContainText(/not longitude\/latitude/);
  await selectNode(page, "n3");
  await expect(page.locator("#map-status")).toContainText(/2 features/);
});

test("a row's geometry opens in the feature panel", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__cities.csv" } },
      {
        id: "n2",
        type: "VertexCreator",
        x: 320,
        y: 60,
        params: { mode: "Replace with Point", x: attr("lon"), y: attr("lat") },
      },
    ],
    [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
  );
  await selectNode(page, "n2");
  await page.locator("#table-body .info-btn").first().click();
  await expect(page.locator("#geometry-modal")).toBeVisible();
  await expect(page.locator("#geometry-body")).toContainText(/POINT|Point/);
});

test("a graph file cannot switch SQL to unrestricted", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await page.setInputFiles("#graph-input", {
    name: "risky.flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "geomarmot-graph",
        version: 1,
        nodes: [
          { id: "n1", type: "SQLTransformer", x: 40, y: 60, params: { sql: "SELECT 1 AS x" }, sqlMode: "unrestricted" },
        ],
        edges: [],
      }),
    ),
  });
  await expect(page.locator("#status")).toContainText("asked for unrestricted SQL");
  await selectNode(page, "n1");
  await expect(page.locator("#inspector .sql-mode input")).not.toBeChecked();
});

test("Arrange lays the nodes out in columns by dependency", async () => {
  const { page } = app;
  await load(page, "cities.csv", CITIES);
  await openGraph(
    page,
    [
      { id: "n1", type: "Reader", x: 600, y: 400, params: { sourceId: "s1__cities.csv" } },
      { id: "n2", type: "Tester", x: 40, y: 40, params: {} },
    ],
    [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
  );
  await page.click("#btn-arrange");
  const reader = await page.locator('[data-node="n1"] .node-body').boundingBox();
  const tester = await page.locator('[data-node="n2"] .node-body').boundingBox();
  expect(reader.x).toBeLessThan(tester.x);
});

test("an H3 index column draws as hexagons, with a coarsen control", async () => {
  const { page } = app;
  const cells = ["8a1f8d7a49a7fff", "8a1f8d7a49b7fff", "8a1f8d7a4987fff"];
  await load(page, "cells.csv", `h3_index,v\n${cells.map((c, k) => `${c},${k}`).join("\n")}\n`);
  await openGraph(page, [{ id: "n1", type: "Reader", x: 40, y: 60, params: { sourceId: "s1__cells.csv" } }], []);
  await selectNode(page, "n1");
  await expect(page.locator("#map-status")).toContainText(/3/);
  await expect(page.locator("#coarsen-select option")).not.toHaveCount(0);
});

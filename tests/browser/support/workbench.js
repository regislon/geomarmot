/* Helpers shared by the workbench specs: load a CSV, open a graph, select a node. */

import { expect } from "@playwright/test";

export const graphFile = (nodes, edges) =>
  Buffer.from(JSON.stringify({ format: "geomarmot-graph", version: 1, nodes, edges }));
export const attr = (column) => ({ kind: "Attribute", column });

export async function load(page, name, text) {
  await page.setInputFiles("#file-input", { name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await expect(page.locator("#status")).toContainText("rows");
}

export async function openGraph(page, nodes, edges) {
  await page.setInputFiles("#graph-input", {
    name: "g.flow.json",
    mimeType: "application/json",
    buffer: graphFile(nodes, edges),
  });
  await expect(page.locator("#status")).toContainText(/nodes ready|Opened|needs a connection|is not connected/);
}

/** Select a node. By position: selecting redraws the canvas, so an element handle would go stale mid-click. */
export async function selectNode(page, id) {
  const title = page.locator(`[data-node="${id}"] .node-title`);
  const type = await title.textContent();
  // A click can land while the canvas redraws: confirm it took, and click again if not.
  for (let attempt = 0; attempt < 3; attempt++) {
    // The canvas redraws on every change: wait for the node to be there, and try again if it moved on.
    await title.waitFor();
    const box = await title.boundingBox();
    if (!box) continue;
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

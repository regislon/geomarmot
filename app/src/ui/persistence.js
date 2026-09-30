/* Autosave, and saving and opening graph files. */

import { load as loadGraph, serialize } from "../core/graph/index.js";
import { render as renderCanvas, select as selectNode } from "./canvas/index.js";
import { onGraphChange } from "./compile-loop.js";
import { setStatus } from "./dom.js";
import { installGraphCustoms } from "../ai/spec/install.js";

const AUTOSAVE_KEY = "geomarmot:graph.v1";
/* ---------- persistence ---------- */

export function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serialize()));
  } catch (err) {
    console.warn("Could not autosave the graph", err);
  }
}

export async function restoreAutosave() {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return;
    const graph = JSON.parse(saved);
    await installGraphCustoms(graph);
    loadGraph(graph, { trusted: true });
    renderCanvas();
  } catch (err) {
    console.warn("Could not restore the saved graph", err);
  }
}

export function exportGraph() {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "graph.flow.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function importGraph(file) {
  try {
    // A graph from a file is never trusted with unrestricted SQL (docs/security.md).
    const saved = JSON.parse(await file.text());
    // Generated transformers the file carries are validated like any other before they are installed.
    const refused = await installGraphCustoms(saved);
    if (refused.length)
      throw new Error(
        `its generated transformer${refused.length === 1 ? "" : "s"} ${refused.join(", ")} did not pass the checks`,
      );
    const { unrestrictedRequested } = loadGraph(saved);
    renderCanvas();
    selectNode(null);
    onGraphChange();
    const restricted = unrestrictedRequested
      ? ` ${unrestrictedRequested} node${unrestrictedRequested === 1 ? "" : "s"} asked for unrestricted SQL; ` +
        "it is off until you review each one and allow it again in the inspector."
      : "";
    setStatus(`Opened ${file.name}. Load the files its Readers need.${restricted}`, Boolean(unrestrictedRequested));
  } catch (err) {
    setStatus(`Could not open that graph: ${err.message}`, true);
  }
}

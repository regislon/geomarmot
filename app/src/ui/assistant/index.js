/*
 * The assistant drawer: a toolbar button opens it beside the canvas, its gear
 * opens the settings, and ./chat.js runs the conversation.
 *
 * This is where the assistant meets the app: `world` gives its tools read
 * access to the live graph, sources and shown generation, and Apply is the one
 * way a draft enters the graph — as a single undo step.
 */

import { readQuery } from "../../core/duck.js";
import { addEdge, graph } from "../../core/graph/index.js";
import { describe } from "../../core/schema.js";
import { clearDraft, draft } from "../../ai/draft.js";
import { sources } from "../../io/sources.js";
import { render as renderCanvas } from "../canvas/index.js";
import * as loop from "../compile-loop.js";
import { setStatus } from "../dom.js";
import { commitHistoryNow } from "../history.js";
import { initChat } from "./chat.js";
import { initAssistantSettings } from "./settings-modal.js";

/** The app as the assistant's tools see it. Live bindings: always the shown generation. */
export const world = {
  graph,
  sources,
  states: () => loop.nodeStates,
  counts: () => loop.portCounts,
  retain: () => loop.retainShown(),
  readQuery,
  describe,
};

/** Merge the draft into the graph as one history step, then recompile. */
export function applyDraft() {
  if (!draft.nodes.length && !draft.edges.length) return;
  const count = draft.nodes.length;
  // One undo step for the whole draft, separate from whatever edit came just before.
  commitHistoryNow();
  for (const node of draft.nodes) graph.nodes.push(structuredClone(node));
  for (const edge of draft.edges) addEdge(edge.from, edge.fromPort, edge.to, edge.toPort);
  clearDraft();
  renderCanvas();
  loop.onGraphChange();
  commitHistoryNow();
  setStatus(`Applied the assistant's draft: ${count} node${count === 1 ? "" : "s"} added.`);
}

export function initAssistant() {
  const drawer = document.getElementById("assistant");
  const settings = initAssistantSettings();
  const chat = initChat({ world, applyDraft });
  document.getElementById("btn-assistant").addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
  });
  document.getElementById("assistant-close").addEventListener("click", () => (drawer.hidden = true));
  document.getElementById("assistant-settings").addEventListener("click", () => settings.open());
  return { drawer, settings, chat };
}

/*
 * The node canvas: SVG, pointer events, no library.
 *
 * The whole scene is re-rendered on every change. That sounds wasteful and is
 * not: a graph is tens of nodes, and a full rebuild removes an entire class of
 * bug where the DOM and the model drift apart after an edit. Dragging is the
 * one exception — it moves a single transform per frame rather than rebuilding,
 * because that path runs at pointer rate.
 */

export { render, screenToWorld } from "./draw.js";
import { graph } from "../../core/graph/index.js";
import { ARRANGE_COLUMN_GAP, ARRANGE_ROW_GAP, el, render, state } from "./draw.js";
import { onKeyDown, onPointerDown, onPointerMove, onPointerUp, onWheel } from "./interact.js";

export function select(nodeId) {
  if (state.selectedId === nodeId) return;
  state.selectedId = nodeId;
  render();
  state.callbacks.onSelect?.(nodeId);
}

export function selected() {
  return state.selectedId;
}

/** Light the eye on each inspected node, in its palette colour. */
/** Colours keyed "nodeId:portId" — one entry per inspected output. */
export function setInspected(colourByKey) {
  state.inspectedColours = colourByKey || new Map();
  render();
}

/** Row counts to show on output ports, keyed "nodeId:portId". */
export function setPortCounts(counts) {
  state.portCounts = counts;
  render();
}

export function setIssues(issues) {
  state.issuesByNode = new Map();
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    const existing = state.issuesByNode.get(issue.nodeId) || [];
    existing.push(issue);
    state.issuesByNode.set(issue.nodeId, existing);
  }
  render();
}

/**
 * Lay the graph out left to right by dependency depth.
 *
 * Depth is the longest path from a source, not the shortest: with the shortest,
 * a node fed by both a Reader and a long branch would sit on top of its own
 * upstream.
 */
export function arrange() {
  const depth = new Map();
  const resolve = (nodeId, seen = new Set()) => {
    if (depth.has(nodeId)) return depth.get(nodeId);
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const parents = graph.edges.filter((edge) => edge.to === nodeId);
    const value = parents.length ? Math.max(...parents.map((edge) => resolve(edge.from, seen) + 1)) : 0;
    depth.set(nodeId, value);
    return value;
  };
  for (const node of graph.nodes) resolve(node.id);

  const perColumn = new Map();
  for (const node of graph.nodes) {
    const column = depth.get(node.id) || 0;
    const row = perColumn.get(column) || 0;
    node.x = 40 + column * ARRANGE_COLUMN_GAP;
    node.y = 40 + row * ARRANGE_ROW_GAP;
    perColumn.set(column, row + 1);
  }
  render();
  state.callbacks.onLayoutChange?.();
}

export function initCanvas(svgElement, handlers) {
  state.svg = svgElement;
  state.callbacks = handlers || {};
  // Focusable so it can own the keyboard; an SVG is not focusable by default.
  state.svg.setAttribute("tabindex", "0");
  state.root = el("g", { class: "viewport" });
  state.svg.replaceChildren(state.root);
  state.svg.addEventListener("pointerdown", onPointerDown);
  state.svg.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  render();
}

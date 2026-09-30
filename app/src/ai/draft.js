// @ts-check
/*
 * The assistant's draft: nodes and edges it proposed that are not in the
 * graph yet. Nothing here touches the graph until the user clicks Apply.
 *
 * Draft node ids come from the graph's own counter (nextNodeId), so applying
 * can never collide with a node the user added meanwhile. Edges may point at
 * graph nodes or at draft nodes.
 */

/** @typedef {{ id: string, type: string, x: number, y: number, params: any, paramOrigin?: any, aiFields?: string[] }} DraftNode */
/** @typedef {{ from: string, fromPort: string, to: string, toPort: string }} DraftEdge */

export const draft = {
  /** @type {DraftNode[]} */
  nodes: [],
  /** @type {DraftEdge[]} */
  edges: [],
  /** Bumped on every change, so a preview can tell it is out of date. */
  seq: 0,
};

const listeners = new Set();

export function hasDraft() {
  return draft.nodes.length > 0 || draft.edges.length > 0;
}

/** Add to the draft, or replace it. */
export function setDraft(nodes, edges, { replace = false } = {}) {
  draft.nodes = replace ? nodes : [...draft.nodes, ...nodes];
  draft.edges = replace ? edges : [...draft.edges, ...edges];
  draft.seq += 1;
  for (const listener of listeners) listener(draft, { replaced: replace });
}

export function clearDraft() {
  setDraft([], [], { replace: true });
}

export function onDraftChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

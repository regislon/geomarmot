/*
 * The graph model: nodes, edges, validation, saving and loading.
 *
 * `graph` is the one graph the canvas edits. The pure helpers (…Of) take any
 * { nodes, edges } so a compiler can work on a snapshot — the main graph at the
 * moment a compile starts, or a copy with a draft merged in.
 */

import { LONLAT } from "../schema.js";
import { canonicalType, defaultParams, transformerFor } from "../../../../transformers/index.js";

export const graph = { nodes: [], edges: [] };

let _nodeCounter = 0;
let _edgeCounter = 0;

export function nodeById(id, g = graph) {
  return g.nodes.find((node) => node.id === id) || null;
}

/** A fresh node id, shared by the graph and by drafts so an applied draft can never collide. */
export function nextNodeId() {
  _nodeCounter += 1;
  return `n${_nodeCounter}`;
}

export function addNode(type, x, y) {
  const node = { id: nextNodeId(), type, x, y, params: defaultParams(type) };
  graph.nodes.push(node);
  return node;
}

export function removeNode(id) {
  graph.nodes = graph.nodes.filter((node) => node.id !== id);
  graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id);
}

export function outputPorts(node) {
  return transformerFor(node.type).outputsFor(node.params);
}

export function inputPorts(node) {
  return transformerFor(node.type).inputs;
}

/**
 * Connect two ports. An input port takes exactly one edge: a second connection
 * replaces the first rather than silently producing a union nobody asked for.
 */
export function addEdge(from, fromPort, to, toPort) {
  if (from === to) return null;
  graph.edges = graph.edges.filter((edge) => !(edge.to === to && edge.toPort === toPort));
  _edgeCounter += 1;
  const edge = { id: `e${_edgeCounter}`, from, fromPort, to, toPort };
  graph.edges.push(edge);
  return edge;
}

export function removeEdge(id) {
  graph.edges = graph.edges.filter((edge) => edge.id !== id);
}

export function incomingEdge(nodeId, port, g = graph) {
  return g.edges.find((edge) => edge.to === nodeId && edge.toPort === port) || null;
}

/** Order nodes so each follows the ones feeding it (Kahn's algorithm); null when there is a cycle. */
export function topoOrder(g = graph) {
  const indegree = new Map(g.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(g.nodes.map((node) => [node.id, []]));
  for (const edge of g.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const byId = new Map(g.nodes.map((node) => [node.id, node]));
  const queue = g.nodes.filter((node) => indegree.get(node.id) === 0);
  const ordered = [];
  // Index cursor rather than shift(): shift() is O(remaining) per call, which
  // turns a wide fan-out quadratic, and this runs on every edit.
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    ordered.push(node);
    for (const nextId of outgoing.get(node.id)) {
      const remaining = indegree.get(nextId) - 1;
      indegree.set(nextId, remaining);
      if (remaining === 0) queue.push(byId.get(nextId));
    }
  }
  return ordered.length === g.nodes.length ? ordered : null;
}

/** Everything that would make a run fail, so the canvas can mark the offending node before any SQL is sent. */
export function validate(sources, g = graph) {
  const issues = [];
  for (const node of g.nodes) {
    const transformer = transformerFor(node.type);
    if (transformer.role === "source") {
      const source = node.params.sourceId ? sources.get(node.params.sourceId) : null;
      if (!source) issues.push({ code: "no-source", nodeId: node.id, message: "Choose a file for this Reader." });
      continue;
    }
    for (const port of transformer.inputs) {
      if (!incomingEdge(node.id, port.id, g)) {
        issues.push({ code: "missing-input", nodeId: node.id, message: `"${port.label}" needs a connection.` });
      }
    }
  }
  if (!topoOrder(g)) issues.push({ code: "cycle", message: "The graph contains a loop — remove a connection." });
  return issues;
}

/**
 * The source feeding a node, found by walking upstream to the nearest source
 * node — however many transformers sit between them.
 */
export function upstreamSource(nodeId, sources, g = graph, seen = new Set()) {
  if (seen.has(nodeId)) return null;
  seen.add(nodeId);
  const node = nodeById(nodeId, g);
  if (!node) return null;
  if (transformerFor(node.type).role === "source") return sources.get(node.params.sourceId) || null;
  for (const edge of g.edges) {
    if (edge.to !== nodeId) continue;
    const found = upstreamSource(edge.from, sources, g, seen);
    if (found) return found;
  }
  return null;
}

/** The CRS feeding a node's input port — what a Writer is about to export. */
export function upstreamCrs(nodeId, portId, crsByNode, g = graph) {
  const edge = incomingEdge(nodeId, portId, g);
  if (!edge) return LONLAT;
  return crsByNode.get(edge.from) || LONLAT;
}

/** The relation feeding a node's input port, in a generation's views. */
export function upstreamView(nodeId, portId, views, g = graph) {
  const edge = incomingEdge(nodeId, portId, g);
  if (!edge) return null;
  return views.get(edge.from)?.[edge.fromPort] || null;
}

/** The saved-graph format; see schemas/graph.schema.json. */
export const GRAPH_FORMAT = "geomarmot-graph";

export function serialize() {
  return {
    format: GRAPH_FORMAT,
    version: 1,
    nodes: graph.nodes.map((node) => ({ ...node, params: structuredClone(node.params) })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    custom: [],
  };
}

/** Bring a node's params forward through its transformer's migrations. */
function migrate(node) {
  const transformer = transformerFor(node.type);
  let version = node.paramsVersion || 1;
  let params = node.params;
  while (version < transformer.paramsVersion) {
    params = transformer.migrations[version](structuredClone(params));
    version += 1;
  }
  return { ...node, params, paramsVersion: transformer.paramsVersion };
}

/**
 * Replace the graph with a saved one.
 *
 * `trusted` is true only for this browser's own autosave and undo history. A
 * graph from anywhere else — an opened file, a pasted graph — comes back with
 * every node's SQL restricted, whatever the file asked for (docs/security.md);
 * the return value says how many nodes asked for unrestricted SQL.
 *
 * Sources are referenced by name, not embedded: a saved graph is a recipe.
 */
export function load(saved, { trusted = false } = {}) {
  if (saved?.format !== GRAPH_FORMAT) throw new Error("This is not a GeoMarmot graph file.");
  if (saved.version !== 1) throw new Error(`Graph format version ${saved.version} is newer than this app.`);
  let unrestrictedRequested = 0;
  graph.nodes = (saved.nodes || []).map((node) => {
    const restored = migrate({ ...node, type: canonicalType(node.type), params: node.params || {} });
    if (restored.sqlMode === "unrestricted" && !trusted) {
      unrestrictedRequested += 1;
      delete restored.sqlMode;
    }
    return restored;
  });
  graph.edges = (saved.edges || []).map((edge) => ({ ...edge }));
  _nodeCounter = Math.max(_nodeCounter, ...graph.nodes.map((node) => Number(node.id.slice(1)) || 0), 0);
  _edgeCounter = Math.max(_edgeCounter, ...graph.edges.map((edge) => Number(edge.id.slice(1)) || 0), 0);
  return { unrestrictedRequested };
}

export function clear() {
  graph.nodes = [];
  graph.edges = [];
}

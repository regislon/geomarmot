// @ts-check
/*
 * Expanding generated transformers before a compile.
 *
 * A generated (Mode B) transformer is not compiled as one node: its
 * definition's `expand(node)` turns each of its nodes into internal nodes — a
 * TemplateStep per SQL step, a real node of the called type per call step —
 * and the compiler compiles those like any other. That way everything the
 * compiler does for a node (the SQL guard at step 0, prepare, needs, the
 * resource rule, leases) applies to generated work unchanged, and a call step
 * is an ordinary restricted node: expansion never carries a sqlMode.
 *
 * Internal ids are `<node>__<step>`. After the compile, the generated node's
 * outputs are aliased to its internal nodes' views, with a state built from
 * theirs, so the rest of the app sees one node.
 */

import { transformerFor } from "../../../../transformers/index.js";

/**
 * One generated node's internal nodes, their wiring, and which internal output each port is.
 * @typedef {{ nodes: Array<{ step: string, type: string, params: any }>,
 *   edges: Array<{ from: { input: string } | { step: string, port: string }, to: string, toPort: string }>,
 *   outputs: Record<string, { step: string, port: string }> }} Expansion
 */

const internalId = (nodeId, step) => `${nodeId}__${step}`;

/**
 * @param {{ nodes: any[], edges: any[] }} graph   a snapshot; not modified
 * @returns {{ graph: { nodes: any[], edges: any[] }, aliases: Map<string, { outputs: Record<string, { node: string, port: string }>, internals: string[] }> }}
 */
export function expandGraph(graph) {
  const expansions = new Map();
  for (const node of graph.nodes) {
    const transformer = transformerFor(node.type);
    if (transformer.expand) expansions.set(node.id, /** @type {Expansion} */ (transformer.expand(node)));
  }
  if (!expansions.size) return { graph, aliases: new Map() };

  /** Where an output of a (possibly generated) node really comes from. */
  const resolve = (nodeId, port, seen = new Set()) => {
    const expansion = expansions.get(nodeId);
    if (!expansion) return { from: nodeId, fromPort: port };
    if (seen.has(nodeId)) throw new Error("Generated transformers form a loop.");
    seen.add(nodeId);
    const out = expansion.outputs[port];
    if (!out) return { from: internalId(nodeId, "__missing"), fromPort: port };
    return { from: internalId(nodeId, out.step), fromPort: out.port };
  };
  const incoming = (nodeId, port) => graph.edges.find((edge) => edge.to === nodeId && edge.toPort === port);

  const nodes = [];
  const edges = [];
  const aliases = new Map();
  let counter = 0;
  const edgeId = () => `x${++counter}`;
  for (const node of graph.nodes) {
    const expansion = expansions.get(node.id);
    if (!expansion) {
      nodes.push(node);
      continue;
    }
    for (const inner of expansion.nodes) {
      nodes.push({ id: internalId(node.id, inner.step), type: inner.type, x: node.x, y: node.y, params: inner.params });
    }
    for (const edge of expansion.edges) {
      if ("input" in edge.from) {
        const upstream = incoming(node.id, edge.from.input);
        if (!upstream) continue; // left unconnected: the internal node reports it
        edges.push({
          id: edgeId(),
          ...resolve(upstream.from, upstream.fromPort),
          to: internalId(node.id, edge.to),
          toPort: edge.toPort,
        });
      } else {
        edges.push({
          id: edgeId(),
          from: internalId(node.id, edge.from.step),
          fromPort: edge.from.port,
          to: internalId(node.id, edge.to),
          toPort: edge.toPort,
        });
      }
    }
    aliases.set(node.id, {
      outputs: Object.fromEntries(
        Object.entries(expansion.outputs).map(([port, out]) => [
          port,
          { node: internalId(node.id, out.step), port: out.port },
        ]),
      ),
      internals: expansion.nodes.map((inner) => internalId(node.id, inner.step)),
    });
  }
  for (const edge of graph.edges) {
    if (expansions.has(edge.to)) continue; // replaced by the internal nodes' own input edges
    edges.push({ ...edge, ...resolve(edge.from, edge.fromPort) });
  }
  return { graph: { nodes, edges }, aliases };
}

/**
 * Give each generated node its outputs, CRS and state from its internal nodes.
 * @param {{ viewMap: Map<string, any>, crsByNode: Map<string, string>, states: Map<string, any> }} record
 * @param {ReturnType<typeof expandGraph>["aliases"]} aliases
 */
export function applyAliases(record, aliases) {
  const owner = new Map();
  for (const [nodeId, alias] of aliases) for (const id of alias.internals) owner.set(id, nodeId);
  for (const [nodeId, alias] of aliases) {
    const views = {};
    let crs = null;
    for (const [port, out] of Object.entries(alias.outputs)) {
      const view = record.viewMap.get(out.node)?.[out.port];
      if (view) views[port] = view;
      crs = crs || record.crsByNode.get(out.node) || null;
    }
    const failed = alias.internals.map((id) => record.states.get(id)).find((state) => state && state.status !== "ok");
    if (failed) {
      const origin = failed.status === "blocked" && !alias.internals.includes(failed.origin) ? failed.origin : nodeId;
      record.states.set(
        nodeId,
        origin === nodeId
          ? { status: "error", message: failed.message, code: failed.code || null }
          : { status: "blocked", origin, message: `Blocked: upstream error in ${origin}.` },
      );
      continue;
    }
    if (Object.keys(views).length === Object.keys(alias.outputs).length) {
      record.viewMap.set(nodeId, views);
      if (crs) record.crsByNode.set(nodeId, crs);
      record.states.set(nodeId, { status: "ok" });
    }
  }
  // A node blocked by a generated node's internals is blocked by the generated node.
  for (const [nodeId, state] of record.states) {
    if (state?.status === "blocked" && owner.has(state.origin) && owner.get(state.origin) !== nodeId) {
      const origin = owner.get(state.origin);
      record.states.set(nodeId, { ...state, origin, message: `Blocked: upstream error in ${origin}.` });
    }
  }
}

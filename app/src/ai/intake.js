// @ts-check
/*
 * Checking what the assistant proposes before it becomes a draft.
 *
 * A proposal is refused whole, with every problem listed, when any node or
 * edge is wrong:
 *   - the type must exist and be usable by the assistant (not a Reader or a Writer)
 *   - params must validate against the transformer's params schema — which
 *     has no `sqlMode` or any other field, so the assistant cannot switch a
 *     node's SQL to unrestricted
 *   - every SQL fragment passes the SQL guard now, in the context it will run
 *     in (and again at every compile, since the node stays restricted)
 *   - edges join an existing output port to an existing input port
 * Accepted params are merged over the defaults, and the ones the assistant
 * wrote are recorded in paramOrigin at the conversation's level.
 */

import { validate as validateSchema } from "../core/jsonschema.js";
import { nextNodeId } from "../core/graph/model.js";
import { fragmentsOf, validate as guard } from "../core/sqlguard/index.js";
import { PALETTE_GROUPS, REGISTRY, defaultParams } from "../../../transformers/index.js";
import { paramsSchemaFor } from "./catalogue.js";
import { draft } from "./draft.js";
import { classify, recordAiParams, structured } from "./gate/index.js";

const REF = /^[a-z][a-z0-9_-]{0,30}$/;
const COLUMN_GAP = 280;
const ROW_GAP = 130;

/**
 * @param {{ nodes: Array<{ ref: string, type: string, params_json: string }>, edges: Array<{ from: string, fromPort: string, to: string, toPort: string }> }} input
 * @param {{ graph: { nodes: any[], edges: any[] }, levelReached: 1|2|3 }} context
 */
export async function intakeProposal(input, { graph, levelReached }) {
  const problems = [];
  const problem = (node, param, error) => problems.push({ node: node ?? null, param: param ?? null, error });
  const refs = new Map();
  const created = [];

  for (const proposed of input.nodes) {
    if (!REF.test(proposed.ref) || refs.has(proposed.ref)) {
      problem(proposed.ref, "ref", structured("INVALID_INPUT", { param: "ref" }));
      continue;
    }
    const transformer = REGISTRY.get(proposed.type);
    if (!transformer || !PALETTE_GROUPS.includes(transformer.group)) {
      problem(proposed.ref, null, structured("UNKNOWN_TRANSFORMER", { transformer: proposed.type }));
      continue;
    }
    if (!transformer.aiUsable) {
      problem(proposed.ref, null, structured("NOT_AI_USABLE", { transformer: proposed.type }));
      continue;
    }
    let written;
    try {
      written = JSON.parse(proposed.params_json || "{}");
    } catch {
      problem(proposed.ref, "params_json", structured("INVALID_INPUT", { param: "params_json" }));
      continue;
    }
    if (!written || typeof written !== "object" || Array.isArray(written)) {
      problem(proposed.ref, "params_json", structured("INVALID_INPUT", { param: "params_json" }));
      continue;
    }
    const schemaErrors = validateSchema(written, paramsSchemaFor(proposed.type));
    if (schemaErrors.length) {
      const param = schemaErrors[0].path.replace(/^\$\.?/, "").split(/[.[]/)[0] || null;
      problem(
        proposed.ref,
        param,
        structured("INVALID_PARAMS", { param: param ?? undefined, transformer: proposed.type }),
      );
      continue;
    }
    const params = { ...defaultParams(proposed.type), ...structuredClone(written) };
    let refused = false;
    for (const fragment of fragmentsOf(transformer, params)) {
      const verdict = await guard(fragment.sql, fragment.context);
      if (!verdict.ok) {
        problem(proposed.ref, fragment.path, classify({ code: verdict.code, message: verdict.message }));
        refused = true;
        break;
      }
    }
    if (refused) continue;
    refs.set(proposed.ref, null);
    created.push({ proposed, transformer, params, written });
  }

  // Resolve edge ends: a ref of this proposal, a draft node, or a graph node.
  const existing = new Map([...graph.nodes, ...draft.nodes].map((node) => [node.id, node]));
  const pending = new Map(created.map((c) => [c.proposed.ref, c]));
  const endpoint = (name) => pending.get(name) || existing.get(name) || null;
  const portsOf = (end, direction) => {
    if (!end) return [];
    if ("proposed" in end) return direction === "out" ? end.transformer.outputsFor(end.params) : end.transformer.inputs;
    const transformer = REGISTRY.get(end.type);
    return direction === "out" ? transformer.outputsFor(end.params) : transformer.inputs;
  };
  const taken = new Set([...graph.edges, ...draft.edges].map((e) => `${e.to}:${e.toPort}`));
  for (const edge of input.edges) {
    const from = endpoint(edge.from);
    const to = endpoint(edge.to);
    if (!from) problem(edge.from, null, structured("UNKNOWN_NODE", { node: edge.from }));
    if (!to) problem(edge.to, null, structured("UNKNOWN_NODE", { node: edge.to }));
    if (!from || !to) continue;
    if (!portsOf(from, "out").some((p) => p.id === edge.fromPort))
      problem(edge.from, null, structured("UNKNOWN_PORT", { node: edge.from, port: edge.fromPort }));
    if (!portsOf(to, "in").some((p) => p.id === edge.toPort))
      problem(edge.to, null, structured("UNKNOWN_PORT", { node: edge.to, port: edge.toPort }));
    if (!("proposed" in to) && taken.has(`${edge.to}:${edge.toPort}`))
      problem(edge.to, null, structured("INVALID_INPUT", { param: `${edge.to}.${edge.toPort} is already connected` }));
  }
  if (problems.length) return { ok: false, nodes: [], edges: [], problems };

  // Accepted: allocate real ids and lay the nodes out right of what feeds them.
  const idOf = new Map();
  const nodes = created.map(({ proposed, params, written }) => {
    const node = { id: nextNodeId(), type: proposed.type, x: 0, y: 0, params, aiFields: Object.keys(written) };
    recordAiParams(node, written, levelReached);
    idOf.set(proposed.ref, node.id);
    return node;
  });
  const resolve = (name) => idOf.get(name) || name;
  const edges = input.edges.map((e) => ({
    from: resolve(e.from),
    fromPort: e.fromPort,
    to: resolve(e.to),
    toPort: e.toPort,
  }));
  layout(nodes, edges, [...graph.nodes, ...draft.nodes]);
  return { ok: true, nodes, edges, problems: [] };
}

/** Place each new node one column right of its rightmost upstream node. */
function layout(nodes, edges, placed) {
  const position = new Map(placed.map((node) => [node.id, node]));
  const bottom = Math.max(40, ...placed.map((node) => node.y + ROW_GAP));
  let spare = 0;
  const perColumn = new Map();
  // Upstream first, so a node listed before the new node feeding it still lands to its right.
  const ordered = [];
  const pending = new Set(nodes);
  while (pending.size) {
    const ready = [...pending].find((node) =>
      edges.every((e) => e.to !== node.id || ![...pending].some((other) => other.id === e.from)),
    );
    const next = ready || pending.values().next().value;
    ordered.push(next);
    pending.delete(next);
  }
  for (const node of ordered) {
    const upstream = edges
      .filter((e) => e.to === node.id)
      .map((e) => position.get(e.from))
      .filter(Boolean);
    if (upstream.length) {
      const x = Math.max(...upstream.map((u) => u.x)) + COLUMN_GAP;
      const slot = perColumn.get(x) || 0;
      perColumn.set(x, slot + 1);
      node.x = x;
      node.y = Math.min(...upstream.map((u) => u.y)) + slot * ROW_GAP;
    } else {
      node.x = 40 + spare * COLUMN_GAP;
      node.y = bottom;
      spare += 1;
    }
    position.set(node.id, node);
  }
}

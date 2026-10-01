// @ts-check
/*
 * What the assistant's tools can find out about the graph, shaped per data
 * level for the privacy gate (ai/gate/). Everything built here is gated before
 * it is sent; this module only reads.
 *
 * `world` is the app's live state, passed in by the UI so this module stays
 * testable: { graph, sources, states(), counts(), retain(), readQuery(sql), describe(relation) }.
 */

import { qid } from "../core/duck.js";
import { LONLAT } from "../core/schema.js";
import { transformerFor } from "../../../transformers/index.js";
import { paramsSchemaFor } from "./catalogue.js";
import { draft } from "./draft.js";
import { PORT_COUNT_CAP } from "../ui/canvas/draw.js";
import { cell, cut, errorPayload, LIMITS, redactParams, sampleRows } from "./gate/index.js";

/** A port count the model can trust: one cut off at the cap is "unknown" rather than wrong. */
const exact = (count) => (count === undefined || count > PORT_COUNT_CAP ? null : count);

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL.*)$/;
const OPAQUE = /^(BLOB|GEOMETRY|WKB_BLOB|BIT|STRUCT.*|MAP.*|UNION.*|.*\[\])$/;
const PROFILE_COLUMNS = 40;

/** Every column name the model is shown at level 1: source schemas. */
function knownColumns(world) {
  const names = new Set();
  for (const source of world.sources.values()) for (const column of source.columns || []) names.add(column.name);
  return names;
}

function nodeState(world, node) {
  const transformer = transformerFor(node.type);
  if (transformer.role === "sink") return { state: "sink", error: null };
  const state = world.states().get(node.id);
  if (!state) return { state: "pending", error: null };
  if (state.status === "ok") return { state: "ok", error: null };
  return { state: state.status === "blocked" ? "blocked" : "error", error: state };
}

/** A node as the graph summary shows it: params redacted by origin, ports with row counts. */
function nodeBrief(world, node, level, isDraft) {
  const transformer = transformerFor(node.type);
  const { state, error } = isDraft ? { state: "pending", error: null } : nodeState(world, node);
  const edges = isDraft ? [...world.graph.edges, ...draft.edges] : world.graph.edges;
  return {
    id: node.id,
    type: node.type,
    params: redactParams(node, level, { schema: paramsSchemaFor(node.type), knownColumns: knownColumns(world) }),
    state,
    error: error ? errorPayload(error, level) : null,
    inputs: transformer.inputs.map((port) => {
      const edge = edges.find((e) => e.to === node.id && e.toPort === port.id);
      return { port: port.id, from: edge?.from ?? null, fromPort: edge?.fromPort ?? null };
    }),
    outputs: transformer.outputsFor(node.params).map((port) => ({
      port: port.id,
      rows: isDraft ? null : exact(world.counts().get(`${node.id}:${port.id}`)),
      crs: null,
      columns: [],
    })),
    ...(isDraft && { draft: true }),
    ...(node.paramOrigin && Object.keys(node.paramOrigin).length && { aiWritten: true }),
  };
}

/** The graph, its sources and the draft, at a level. Synchronous: counts come from the canvas. */
export function summarizeGraph(world, level) {
  return {
    level,
    sources: [...world.sources.values()].map((source) => ({
      id: source.id,
      name: cut(source.name, 200),
      format: source.format,
      rows: source.rows || 0,
      crs: source.crs?.code ?? null,
      columns: (source.columns || []).map(({ name, type }) => ({ name, type })),
      layer: source.layer ?? null,
    })),
    nodes: [
      ...world.graph.nodes.map((node) => nodeBrief(world, node, level, false)),
      ...draft.nodes.map((node) => nodeBrief(world, node, level, true)),
    ],
    edges: [
      ...world.graph.edges.map(({ from, fromPort, to, toPort }) => ({ from, fromPort, to, toPort })),
      ...draft.edges,
    ],
  };
}

/** Level 2: per-column statistics of a relation. */
export async function profile(world, relation, columns) {
  const cols = columns.slice(0, PROFILE_COLUMNS);
  const parts = ["count(*) AS n"];
  cols.forEach((column, i) => {
    const c = qid(column.name);
    parts.push(`count(${c}) AS nn${i}`);
    if (column.type === "GEOMETRY") {
      parts.push(
        `min(ST_XMin(${c})) AS x0${i}`,
        `min(ST_YMin(${c})) AS y0${i}`,
        `max(ST_XMax(${c})) AS x1${i}`,
        `max(ST_YMax(${c})) AS y1${i}`,
      );
    } else if (!OPAQUE.test(column.type)) {
      const cast = NUMERIC.test(column.type) ? "DOUBLE" : "VARCHAR";
      parts.push(`count(DISTINCT ${c}) AS d${i}`, `min(${c})::${cast} AS lo${i}`, `max(${c})::${cast} AS hi${i}`);
    }
  });
  const [row] = await world.readQuery(`SELECT ${parts.join(", ")} FROM ${relation}`);
  const total = Number(row.n) || 0;
  const out = [];
  for (const [i, column] of cols.entries()) {
    const nonNull = Number(row[`nn${i}`]) || 0;
    /** @type {any} */
    const stat = { name: column.name, nullShare: total ? (total - nonNull) / total : 0, distinct: 0 };
    if (column.type === "GEOMETRY") {
      const box = [row[`x0${i}`], row[`y0${i}`], row[`x1${i}`], row[`y1${i}`]].map(Number);
      stat.extent = box.every(Number.isFinite) ? box : null;
    } else if (!OPAQUE.test(column.type)) {
      stat.distinct = Number(row[`d${i}`]) || 0;
      stat.min = cell(row[`lo${i}`], LIMITS.topValueChars);
      stat.max = cell(row[`hi${i}`], LIMITS.topValueChars);
      const c = qid(column.name);
      const top = await world.readQuery(
        `SELECT ${c}::VARCHAR AS v, count(*) AS k FROM ${relation} WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${LIMITS.topValues}`,
      );
      stat.top = top.map((t) => ({ value: cell(t.v, LIMITS.topValueChars), count: Number(t.k) }));
    }
    out.push(stat);
  }
  return out;
}

/** Level 3: the first rows of a relation, geometry as WKT, every cell cut. */
export async function sample(world, relation, columns) {
  const select = columns
    .map((column) =>
      column.type === "GEOMETRY"
        ? `ST_AsText(${qid(column.name)}) AS ${qid(column.name)}`
        : OPAQUE.test(column.type)
          ? `'(binary)' AS ${qid(column.name)}`
          : qid(column.name),
    )
    .join(", ");
  const rows = await world.readQuery(`SELECT ${select || "*"} FROM ${relation} LIMIT ${LIMITS.rows}`);
  return sampleRows(columns, rows);
}

/**
 * One node in detail: its params, state and every output's schema, plus
 * statistics at level 2 and sample rows at level 3. Reads hold a lease on the
 * shown generation, so a recompile cannot drop what is being read.
 */
export async function inspectNode(world, nodeId, level) {
  const node = world.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const brief = nodeBrief(world, node, level, false);
  if (brief.state !== "ok") return brief;
  const lease = world.retain();
  try {
    const views = lease.views.get(node.id) || {};
    brief.outputs = [];
    for (const port of transformerFor(node.type).outputsFor(node.params)) {
      const relation = views[port.id];
      if (!relation) continue;
      const columns = await world.describe(relation);
      /** @type {any} */
      const out = {
        port: port.id,
        rows: exact(world.counts().get(`${node.id}:${port.id}`)),
        crs: lease.crsByNode.get(node.id) || LONLAT,
        columns,
      };
      if (level >= 2) out.stats = await profile(world, relation, columns);
      if (level >= 3) out.sample = await sample(world, relation, columns);
      brief.outputs.push(out);
    }
    return brief;
  } finally {
    lease.release();
  }
}

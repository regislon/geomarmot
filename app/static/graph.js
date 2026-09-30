/*
 * The graph model: nodes, edges, validation, and compilation into DuckDB views.
 *
 * Compilation drops every view it previously made and rebuilds them in
 * dependency order. Replacing them in place would be fewer statements, but
 * DuckDB tracks view dependencies and refuses to replace a view something else
 * reads — so a rebuild after an edit to an upstream node would fail on exactly
 * the graphs that matter. Dropping first sidesteps the whole question, and
 * costs nothing: a view holds no data.
 */

import { exec, qid, qlit, query } from "./duck.js";
import { describe, geometryExpression, isLonLat, isLonLatCode, LONLAT } from "./schema.js";
import { sourceRelation } from "./sources.js";
import { transformerFor, defaultParams } from "./transformers.js";

export const graph = { nodes: [], edges: [] };

let _nodeCounter = 0;
let _edgeCounter = 0;
// Views this module created, newest last, so they can be dropped in reverse.
const _createdViews = [];
// Tables a transformer's prepare step materialised, dropped on the next build.
const _createdTables = [];

/** Deterministic, SQL-safe view name for one output port of one node. */
export function viewName(nodeId, port) {
  return `n_${nodeId}_${port}`;
}

export function nodeById(id) {
  return graph.nodes.find((node) => node.id === id) || null;
}

export function addNode(type, x, y) {
  _nodeCounter += 1;
  const node = { id: `n${_nodeCounter}`, type, x, y, params: defaultParams(type) };
  graph.nodes.push(node);
  return node;
}

export function removeNode(id) {
  graph.nodes = graph.nodes.filter((node) => node.id !== id);
  graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id);
}

export function outputPorts(node) {
  return transformerFor(node.type).outputs(node);
}

export function inputPorts(node) {
  return transformerFor(node.type).inputs;
}

/**
 * Connect two ports.
 *
 * An input port takes exactly one edge: a second connection replaces
 * the first rather than silently producing a union nobody asked for.
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

export function incomingEdge(nodeId, port) {
  return graph.edges.find((edge) => edge.to === nodeId && edge.toPort === port) || null;
}

/**
 * Order nodes so each follows the ones feeding it (Kahn's algorithm).
 * Returns null when the graph contains a cycle.
 */
export function topoOrder() {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0);
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
  return ordered.length === graph.nodes.length ? ordered : null;
}

/**
 * Everything that would make a run fail, so the canvas can mark the offending
 * node before any SQL is sent.
 */
export function validate(sources) {
  const issues = [];
  for (const node of graph.nodes) {
    if (node.type === "Reader") {
      const source = node.params.sourceId ? sources.get(node.params.sourceId) : null;
      if (!source) {
        issues.push({ code: "no-source", nodeId: node.id, message: "Choose a file for this Reader." });
      }
      continue;
    }
    for (const port of inputPorts(node)) {
      if (!incomingEdge(node.id, port.id)) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          message: `"${port.label}" needs a connection.`,
        });
      }
    }
  }
  if (!topoOrder()) {
    issues.push({ code: "cycle", message: "The graph contains a loop — remove a connection." });
  }
  return issues;
}

async function dropCreatedViews() {
  // Reverse order: a dependent view has to go before the view it reads.
  while (_createdViews.length) {
    const name = _createdViews.pop();
    try {
      await exec(`DROP VIEW IF EXISTS ${name}`);
    } catch (err) {
      console.warn(`Could not drop view ${name}`, err);
    }
  }
  // Tables come after the views, which may have been reading them.
  while (_createdTables.length) {
    const name = _createdTables.pop();
    try {
      await exec(`DROP TABLE IF EXISTS ${name}`);
    } catch (err) {
      console.warn(`Could not drop table ${name}`, err);
    }
  }
}

/**
 * The source feeding a node, found by walking upstream to the nearest Reader.
 *
 * Lets an H3 node default its parent cell to the one the file is named after,
 * however many transformers sit between it and the Reader.
 */
function upstreamSource(nodeId, sources, seen = new Set()) {
  if (seen.has(nodeId)) return null;
  seen.add(nodeId);
  const node = nodeById(nodeId);
  if (!node) return null;
  if (node.type === "Reader") return sources.get(node.params.sourceId) || null;
  for (const edge of graph.edges) {
    if (edge.to !== nodeId) continue;
    const found = upstreamSource(edge.from, sources, seen);
    if (found) return found;
  }
  return null;
}

/**
 * The CRS to read a source's geometry as, or null when it is not known.
 *
 * A CRS the file did not actually declare (`assumed`) is not good enough to
 * reproject from — transforming out of a guessed CRS moves the data somewhere
 * confidently wrong, which is worse than not drawing it. The override exists
 * for exactly that case, and for files that declare the wrong one.
 */
export function effectiveCrs(node, source) {
  const override = (node.params.crs || "").trim();
  if (override) return { code: override, assumed: false };
  return source.crs && !source.crs.assumed ? source.crs : null;
}

/** Whether this Reader will reproject, and from what. */
export function reprojectionFor(node, source) {
  if (!source?.geometry) return null;
  const crs = effectiveCrs(node, source);
  return crs && !isLonLat(crs) ? crs : null;
}

/**
 * Normalise a source's geometry to lon/lat at read time.
 *
 * Doing it here rather than at display time keeps one rule for the whole graph:
 * everything downstream of a Reader is EPSG:4326. That matters most on the way
 * out — DuckDB writes GeoParquet with no CRS in the `geo` block, which readers
 * take to mean OGC:CRS84, so exporting projected coordinates would produce a
 * file that lies about itself.
 *
 * always_xy is not optional. PROJ honours EPSG:4326's authority axis order,
 * which is latitude first, so without it every transformed point comes back
 * with its coordinates swapped.
 */
function reprojectedGeometry(source, crs) {
  const column = qid(source.geometry.name);
  const expr = geometryExpression(source.geometry);
  return `ST_Transform(${expr}, ${qlit(crs.code)}, 'EPSG:4326', always_xy := true) AS ${column}`;
}

/**
 * Whether this Reader should expose the physical row number.
 *
 * Auto says yes for a dense positional H3 tile, which is the only thing that
 * needs it — and needs it badly, since `row_number() OVER ()` would be wrong:
 * DuckDB's parallel scan makes no promise that a window function sees rows in
 * file order, and the whole positional contract is about file order.
 */
function rowNumberWanted(node, source) {
  // Parquet-only: file_row_number is an option of DuckDB's parquet reader, and
  // neither GDAL's reader nor read_csv has anything like it.
  if (source.format !== "parquet") return false;
  const mode = node.params.rowNumber || "Auto";
  if (mode === "Yes") return true;
  if (mode === "No") return false;
  return source.h3?.mode === "positional";
}

/**
 * The Reader's SQL: read the file, normalise its CRS, and optionally carry the
 * row number through.
 *
 * It deliberately does not create H3 indexes or geometry — those are their own
 * transformers, so the cost and the choice are visible on the canvas.
 */
function readerSql(node, sources) {
  const source = sources.get(node.params.sourceId);
  if (!source) throw new Error("Reader has no source.");
  const relation = sourceRelation(source, { rowNumber: rowNumberWanted(node, source) });

  const reprojection = reprojectionFor(node, source);
  if (reprojection) {
    const column = qid(source.geometry.name);
    return `SELECT * EXCLUDE (${column}), ${reprojectedGeometry(source, reprojection)} FROM ${relation}`;
  }
  return `SELECT * FROM ${relation}`;
}

/**
 * Build every node's views, in dependency order.
 *
 * Returns {views, error}: `views` maps nodeId -> {portId: viewName} for every
 * node that compiled. A failing node stops the build but leaves the views made
 * so far in place, so the upstream part of a broken graph stays inspectable.
 */
/**
 * The CRS arriving at a node, and the one leaving it.
 *
 * The Reader normalises to lon/lat, so that is the baseline for the whole
 * graph; a node inherits its input's CRS unless it declares one of its own
 * through a `crs` hook. Two inputs in different coordinate systems is a real
 * error rather than something to pick a winner from — the geometries would be
 * overlaid, joined or unioned without ever lining up on the ground.
 */
function incomingCrs(node, transformer, crsByNode) {
  const seen = new Set();
  for (const port of transformer.inputs) {
    const edge = incomingEdge(node.id, port.id);
    if (edge) seen.add(crsByNode.get(edge.from) || LONLAT);
  }
  if (seen.size > 1) {
    throw new Error(`Its inputs are in different coordinate systems (${[...seen].join(", ")}).`);
  }
  return [...seen][0] || LONLAT;
}

export async function compile(sources) {
  await dropCreatedViews();

  const ordered = topoOrder();
  const views = new Map();
  const crsByNode = new Map();
  if (!ordered) return { views, crsByNode, error: { message: "The graph contains a loop." } };

  for (const node of ordered) {
    const transformer = transformerFor(node.type);
    if (!transformer.outputs(node).length) continue; // Writer and friends

    let statements;
    try {
      if (node.type === "Reader") {
        statements = { output: readerSql(node, sources) };
        crsByNode.set(node.id, LONLAT);
      } else {
        const upstream = {};
        for (const port of transformer.inputs) {
          const edge = incomingEdge(node.id, port.id);
          if (!edge) throw new Error(`"${port.label}" is not connected.`);
          const upstreamView = views.get(edge.from)?.[edge.fromPort];
          if (!upstreamView) throw new Error("The connected node did not produce anything.");
          upstream[port.id] = upstreamView;
        }
        // A join has to know both sides' columns to spot name collisions and an
        // H3 node has to know the row count to work out its resolution — but
        // most transformers need neither, and a round trip per node per rebuild
        // is not free, so only the ones that ask for it pay for it.
        const crs = incomingCrs(node, transformer, crsByNode);
        // One gate for every node that is written against lon/lat — the H3
        // family, the overlayer — rather than a guess buried in each one.
        if (transformer.needsLonLat && !isLonLatCode(crs)) {
          throw new Error(
            `${node.type} works in longitude/latitude, but its input is in ${crs}. ` +
              `Reproject back to ${LONLAT} before it.`,
          );
        }
        const ctx = { schemas: null, rowCount: null, source: null, crs };
        if (transformer.needsSchema) {
          ctx.schemas = {};
          for (const port of transformer.inputs) ctx.schemas[port.id] = await describe(upstream[port.id]);
        }
        if (transformer.needsRowCount) {
          const counted = await query(`SELECT count(*) AS n FROM ${upstream[transformer.inputs[0].id]}`);
          ctx.rowCount = Number(counted[0]?.n ?? 0);
          ctx.source = upstreamSource(node.id, sources);
        }
        if (transformer.prepare) {
          const prepared = await transformer.prepare(node, upstream, ctx);
          for (const table of prepared?.tables || []) _createdTables.push(table);
        }
        statements = transformer.sql(node, upstream, ctx);
        crsByNode.set(node.id, transformer.crs ? transformer.crs(node, crs) : crs);
        // Before the view is published, so nothing downstream ever reads a
        // relation whose own node considers itself misconfigured.
        if (transformer.check) await transformer.check(node, upstream, ctx);
      }

      const produced = {};
      for (const [port, sql] of Object.entries(statements)) {
        const name = viewName(node.id, port);
        await exec(`CREATE OR REPLACE VIEW ${name} AS ${sql}`);
        _createdViews.push(name);
        produced[port] = name;
      }
      views.set(node.id, produced);
    } catch (err) {
      return { views, crsByNode, error: { nodeId: node.id, message: err.message || String(err) } };
    }
  }
  return { views, crsByNode, error: null };
}

/** The CRS feeding a node's input port — what a Writer is about to export. */
export function upstreamCrs(nodeId, portId, crsByNode) {
  const edge = incomingEdge(nodeId, portId);
  if (!edge) return LONLAT;
  return crsByNode.get(edge.from) || LONLAT;
}

/** The view feeding a node's input port, for Writer export and inspection. */
export function upstreamView(nodeId, portId, views) {
  const edge = incomingEdge(nodeId, portId);
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

/**
 * Replace the graph with a saved one.
 *
 * Sources are referenced by name, not embedded — a saved graph is a recipe, and
 * the files have to be dropped in again. The counters are advanced past the
 * loaded ids so a node added afterwards cannot collide with a loaded one.
 */
export function load(saved) {
  if (saved?.format !== GRAPH_FORMAT) throw new Error("This is not a GeoMarmot graph file.");
  if (saved.version !== 1) throw new Error(`Graph format version ${saved.version} is newer than this app.`);
  graph.nodes = (saved.nodes || []).map((node) => {
    const restored = { ...node, params: node.params || {} };
    // A parameter's shape can change between versions; the transformer that
    // owns it is the only thing that knows how to bring an old graph forward.
    transformerFor(restored.type)?.migrate?.(restored);
    return restored;
  });
  graph.edges = (saved.edges || []).map((edge) => ({ ...edge }));
  _nodeCounter = graph.nodes.reduce((max, node) => Math.max(max, Number(node.id.slice(1)) || 0), 0);
  _edgeCounter = graph.edges.reduce((max, edge) => Math.max(max, Number(edge.id.slice(1)) || 0), 0);
}

export function clear() {
  graph.nodes = [];
  graph.edges = [];
}

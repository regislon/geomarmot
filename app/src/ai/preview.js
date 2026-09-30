// @ts-check
/*
 * Draft previews, isolated from the user's graph.
 *
 * A preview runs the draft in its own DuckDB instance (docs/decisions/0004):
 *
 *   1. Each output of the user's graph that feeds the draft is sampled — at
 *      most 1,000 rows — into Parquet by the main engine, which is a read like
 *      any other.
 *   2. The Parquet goes into the preview engine as a table, read by an internal
 *      PreviewInput node that carries the upstream CRS.
 *   3. A compiler in namespace d<n>, on the preview engine, compiles the draft
 *      over those inputs, with prepare caps cut to a tenth.
 *   4. The draft's outputs are described, counted and — per data level —
 *      profiled or sampled (reads LIMIT 100), for the privacy gate.
 *
 * Nothing in the preview engine can read or drop anything of the user's graph,
 * and a preview that runs past 10 s is stopped by terminating the preview
 * engine, which costs the user nothing. The engine lives as long as the draft:
 * it is disposed on Apply, on Discard and when a new draft replaces the old
 * one, once the last read on it has finished.
 */

import { copyToBuffer, createIsolatedEngine, qlit } from "../core/duck.js";
import { createCompiler } from "../core/graph/compiler.js";
import { inspectNode } from "./context.js";
import { draft as liveDraft, hasDraft, onDraftChange } from "./draft.js";
import "./preview-input.js";

export const SAMPLE_ROWS = 1_000;
export const PREVIEW_READ_ROWS = 100;
export const PREVIEW_TIMEOUT_MS = 10_000;
const PREVIEW_LIMITS = { overlayFeatures: 2_000, materialisedCells: 200_000 };

/** @type {null | { id: number, engine: any, compiler: any, graph: any, reads: number, disposing: boolean, closed?: boolean }} */
let session = null;
let sessions = 0;
/** Bumped by every dispose, so a session that finished booting after a Discard knows it is already over. */
let epoch = 0;
const stats = { started: 0, terminated: 0 };

async function openSession() {
  if (session && !session.disposing) return session;
  sessions += 1;
  const engine = await createIsolatedEngine();
  stats.started += 1;
  /** @type {any} */
  const s = { id: sessions, engine, graph: { nodes: [], edges: [] }, reads: 0, disposing: false };
  s.compiler = createCompiler({
    namespace: `d${s.id}`,
    getGraph: () => s.graph,
    getSources: () => new Map(),
    engine,
    limits: PREVIEW_LIMITS,
  });
  session = s;
  return s;
}

async function closeSession(s) {
  if (s.reads > 0 || s.closed) return; // the last read closes it
  s.closed = true;
  if (session === s) session = null;
  await s.compiler.dispose().catch(() => {});
  await s.engine.terminate();
  stats.terminated += 1;
}

/** Dispose the draft's preview engine: at once, or when its last read finishes. */
export function disposePreview() {
  epoch += 1;
  if (!session) return;
  const s = session;
  s.disposing = true;
  session = null;
  return closeSession(s);
}

onDraftChange((_draft, { replaced }) => {
  if (!hasDraft() || replaced) disposePreview();
});

/** For tests: preview engines started and terminated, and whether one is open. */
export function previewStats() {
  return { ...stats, open: Boolean(session) };
}

/** Race a step against the preview watchdog; on timeout the preview engine is thrown away. */
async function watched(s, promise) {
  let timer;
  const overdue = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`The query took longer than ${PREVIEW_TIMEOUT_MS / 1000} s and was stopped.`));
    }, PREVIEW_TIMEOUT_MS);
  });
  // The loser of the race still settles later; it must not surface as an unhandled rejection.
  promise.catch(() => {});
  try {
    return await Promise.race([promise, overdue]);
  } catch (err) {
    if (/took longer than/.test(err.message)) {
      // Nothing on a runaway preview engine is worth waiting for: stop it now.
      s.disposing = true;
      if (session === s) session = null;
      if (!s.closed) {
        s.closed = true;
        await s.engine.terminate();
        stats.terminated += 1;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sample the graph outputs the draft reads into the preview engine, and build
 * the graph the preview compiler compiles: the draft, fed by PreviewInput nodes.
 */
async function materialise(world, s, draft) {
  const draftIds = new Set(draft.nodes.map((node) => node.id));
  const feeds = new Map(); // "node:port" -> PreviewInput node id
  const nodes = draft.nodes.map((node) => structuredClone(node));
  const lease = world.retain();
  try {
    for (const edge of draft.edges) {
      if (draftIds.has(edge.from) || feeds.has(`${edge.from}:${edge.fromPort}`)) continue;
      const k = feeds.size + 1;
      const id = `p${k}`;
      feeds.set(`${edge.from}:${edge.fromPort}`, id);
      const view = lease.views.get(edge.from)?.[edge.fromPort];
      const crs = lease.crsByNode.get(edge.from) || "EPSG:4326";
      if (!view) {
        nodes.push({ id, type: "PreviewInput", x: 0, y: 0, params: { table: `pin_${k}`, crs, blockedBy: edge.from } });
        continue;
      }
      const file = `__preview_${s.id}_${k}.parquet`;
      const bytes = await copyToBuffer(
        `COPY (SELECT * FROM ${view} LIMIT ${SAMPLE_ROWS}) TO ${qlit(file)} (FORMAT PARQUET)`,
        file,
      );
      await s.engine.registerFileBuffer(file, bytes);
      try {
        await s.engine.exec(`CREATE OR REPLACE TABLE pin_${k} AS SELECT * FROM read_parquet(${qlit(file)})`);
      } finally {
        await s.engine.dropFile(file).catch(() => {});
      }
      nodes.push({ id, type: "PreviewInput", x: 0, y: 0, params: { table: `pin_${k}`, crs } });
    }
  } finally {
    lease.release();
  }
  const edges = draft.edges.map((edge, index) => {
    const feed = feeds.get(`${edge.from}:${edge.fromPort}`);
    return { id: `e${index + 1}`, ...edge, ...(feed && { from: feed, fromPort: "output" }) };
  });
  return { graph: { nodes, edges }, back: new Map([...feeds].map(([key, id]) => [id, key.split(":")[0]])) };
}

/** Replace preview-internal node ids (p1) in a payload with the graph nodes they stand for. */
function renameInternal(payload, back) {
  const fix = (value) => (typeof value === "string" && back.has(value) ? back.get(value) : value);
  for (const input of payload.inputs || []) input.from = fix(input.from);
  if (payload.error?.params?.node) payload.error.params.node = fix(payload.error.params.node);
  if (payload.error?.raw) payload.error.raw = payload.error.raw.replace(/\bp\d+\b/g, (id) => fix(id));
  return payload;
}

/**
 * Preview the whole draft at a data level: a node payload per draft node.
 * @returns {Promise<{ nodes: any[] }>}
 */
export async function previewDraft(world, level) {
  if (!hasDraft()) return { nodes: [] };
  // The draft as it is now: a Discard or a new proposal while this runs must not change what it reads.
  const draft = { nodes: structuredClone(liveDraft.nodes), edges: structuredClone(liveDraft.edges) };
  const started = epoch;
  const s = await openSession();
  if (epoch !== started && session === s) {
    // Discarded while the engine was booting: finish this read, then close.
    s.disposing = true;
    session = null;
  }
  s.reads += 1;
  try {
    const { graph, back } = await watched(s, materialise(world, s, draft));
    s.graph = graph;
    await watched(s, s.compiler.compile());
    const lease = s.compiler.acquire();
    try {
      const counts = new Map();
      for (const [nodeId, byPort] of lease.views) {
        if (!draft.nodes.some((node) => node.id === nodeId)) continue;
        for (const [port, view] of Object.entries(byPort)) {
          const [row] = await watched(s, s.engine.query(`SELECT count(*) AS n FROM ${view}`));
          counts.set(`${nodeId}:${port}`, Number(row.n));
        }
      }
      // Reads see at most PREVIEW_READ_ROWS rows of each draft output.
      const limited = new Map(
        [...lease.views].map(([nodeId, byPort]) => [
          nodeId,
          Object.fromEntries(
            Object.entries(byPort).map(([port, view]) => [
              port,
              `(SELECT * FROM ${view} LIMIT ${PREVIEW_READ_ROWS}) AS _p`,
            ]),
          ),
        ]),
      );
      const previewWorld = {
        // Shown to the model with their graph ids and connections, not the preview's internal ones.
        graph: { nodes: draft.nodes, edges: [...world.graph.edges, ...draft.edges] },
        sources: world.sources,
        states: () => lease.states,
        counts: () => counts,
        retain: () => {
          const held = lease.retain();
          return { ...held, views: limited, release: () => held.release() };
        },
        readQuery: (sql) => watched(s, s.engine.query(sql)),
        describe: async (relation) =>
          (await s.engine.query(`DESCRIBE SELECT * FROM ${relation}`)).map((row) => ({
            name: row.column_name,
            type: String(row.column_type || "").toUpperCase(),
          })),
      };
      const nodes = [];
      for (const node of draft.nodes) {
        const payload = await inspectNode(previewWorld, node.id, level);
        if (payload) nodes.push(renameInternal({ ...payload, draft: true }, back));
      }
      return { nodes };
    } finally {
      lease.release();
    }
  } finally {
    s.reads -= 1;
    if (s.disposing && s.reads <= 0) await closeSession(s);
  }
}

/*
 * The compiler: a graph becomes one DuckDB view per output port, per generation.
 *
 * Every compile is a new generation, and names everything it makes after it
 * (`<ns>_g<gen>_<nodeId>_<port>`, tables `<ns>_g<gen>_t_<nodeId>_<suffix>`). A
 * compile only ever creates its own generation's relations, and those only read
 * each other, so generations never depend on one another. Readers take a lease
 * on the latest completed generation; a generation replaced by a newer one is
 * retired, and dropped only when its last lease is released — so a read that
 * started before an edit always finishes against what it started with.
 *
 * The contract every hook follows is docs/transformer-api.md; the rules for
 * when views and tables are dropped are the "resource rule" there:
 *   (a) published resources go when their generation is retired and unleased;
 *   (b) a failed node's resources, and an aborted compile's, go at once.
 */

import { mainEngine, onEngineRestart, qid, qlit } from "../duck.js";
import { LONLAT, isLonLatCode } from "../schema.js";
import { sourceRelation } from "../../io/sources.js";
import { guardNode } from "../sqlguard/index.js";
import { transformerFor } from "../../../../transformers/index.js";
import { incomingEdge, topoOrder, upstreamSource } from "./model.js";
import { runNode } from "./node.js";
import { applyAliases, expandGraph } from "./expand.js";

class AbortError extends Error {}

/**
 * @param {{ namespace: string, getGraph: () => {nodes: any[], edges: any[]}, getSources: () => Map<string, any>,
 *   engine?: import("../duck.js").Engine, limits?: { overlayFeatures: number, materialisedCells: number } }} options
 *   `engine` is what the compiler and every hook run SQL on (ctx.engine): the main engine unless given.
 */
export function createCompiler({ namespace, getGraph, getSources, engine = mainEngine, limits }) {
  let connection = null;
  let generation = 0;
  let current = null; // the generation new leases get
  const retired = new Set(); // replaced generations still waiting for their leases
  let running = null; // { controller, promise }
  let pending = null; // { resolve list } for the next compile to start
  let disposed = false;
  const idleWaiters = [];

  async function conn() {
    if (!connection) connection = await engine.connect();
    return connection;
  }

  async function drop(record) {
    const c = await conn();
    for (const name of [...record.views].reverse()) {
      await c.query(`DROP VIEW IF EXISTS ${name}`).catch((err) => console.warn(`Could not drop ${name}`, err));
    }
    for (const name of [...record.tables].reverse()) {
      await c.query(`DROP TABLE IF EXISTS ${name}`).catch((err) => console.warn(`Could not drop ${name}`, err));
    }
    record.views.length = 0;
    record.tables.length = 0;
  }

  async function dropRetiredUnleased() {
    for (const record of [...retired]) {
      if (record.leases > 0) continue;
      retired.delete(record);
      await drop(record);
    }
    wakeBackpressure();
  }

  let backpressureWaiters = [];
  function wakeBackpressure() {
    const waiters = backpressureWaiters;
    backpressureWaiters = [];
    for (const wake of waiters) wake();
  }
  /** Backpressure: a new generation is only allocated once every retired one has been dropped. */
  async function waitForRetired(signal) {
    const started = Date.now();
    let warned = false;
    while (retired.size) {
      if (signal.aborted) throw new AbortError();
      await new Promise((resolve) => {
        backpressureWaiters.push(resolve);
        setTimeout(resolve, 5_000);
      });
      // A lease held this long is almost certainly a read that forgot to release it.
      if (!warned && Date.now() - started > 10_000 && retired.size) {
        warned = true;
        console.warn(
          `${namespace}: a compile has waited 10 s for leased generations`,
          [...retired].map((r) => ({ gen: r.gen, leases: r.leases })),
        );
      }
    }
  }

  function lease(record) {
    if (!record) {
      const empty = { gen: 0, views: new Map(), crsByNode: new Map(), states: new Map(), release() {} };
      empty.retain = () => empty;
      return empty;
    }
    record.leases += 1;
    let released = false;
    return {
      gen: record.gen,
      views: record.viewMap,
      crsByNode: record.crsByNode,
      states: record.states,
      /** Another lease on the same generation, for a read that may outlive this one. */
      retain: () => lease(record),
      release() {
        if (released) return;
        released = true;
        record.leases -= 1;
        if (record.leases === 0 && retired.has(record)) dropRetiredUnleased();
      },
    };
  }

  async function compileOnce(signal) {
    await waitForRetired(signal);
    if (signal.aborted) throw new AbortError();
    generation += 1;
    const gen = generation;
    let snapshot = structuredClone(getGraph());
    const sources = getSources();
    let aliases = new Map();
    const record = {
      gen,
      views: [],
      tables: [],
      viewMap: new Map(),
      crsByNode: new Map(),
      states: new Map(),
      leases: 0,
      error: null,
    };
    const c = await conn();
    try {
      // Generated transformers compile as their internal nodes (./expand.js).
      ({ graph: snapshot, aliases } = expandGraph(snapshot));
      const ordered = topoOrder(snapshot);
      if (!ordered) {
        record.error = { message: "The graph contains a loop." };
      } else {
        for (const node of ordered) {
          if (signal.aborted) throw new AbortError();
          await compileNode(node, snapshot, sources, record, c, signal);
          if (!record.error && record.states.get(node.id)?.status === "error") {
            record.error = { nodeId: node.id, message: record.states.get(node.id).message };
          }
        }
      }
    } catch (err) {
      await drop(record); // rule (b): never leased, so it can go at once
      throw err;
    }
    if (signal.aborted) {
      await drop(record);
      throw new AbortError();
    }
    applyAliases(record, aliases);
    const internal = record.error?.nodeId?.split("__");
    if (internal && internal.length > 1 && aliases.has(internal[0])) record.error.nodeId = internal[0];
    // Publish: this generation replaces the current one, which retires.
    if (current) retired.add(current);
    current = record;
    await dropRetiredUnleased();
    return record;
  }

  async function compileNode(node, snapshot, sources, record, c, signal) {
    const transformer = transformerFor(node.type);
    const outputs = transformer.outputsFor(node.params);
    if (transformer.role === "sink" || (!outputs.length && transformer.role !== "source")) return;

    // Downstream of a failure: blocked, with nothing in this generation.
    for (const port of transformer.inputs) {
      const edge = incomingEdge(node.id, port.id, snapshot);
      const upstream = edge && record.states.get(edge.from);
      if (upstream && upstream.status !== "ok") {
        const origin = upstream.status === "blocked" ? upstream.origin : edge.from;
        record.states.set(node.id, { status: "blocked", origin, message: `Blocked: upstream error in ${origin}.` });
        return;
      }
    }

    const owned = { tables: [], views: [] };
    try {
      // Step 0: the SQL guard, before any hook or query.
      const refusal = await guardNode(transformer, node);
      if (refusal) {
        const err = new Error(refusal.message);
        err.code = refusal.code;
        throw err;
      }
      const inputs = {};
      const crsSeen = new Set();
      for (const port of transformer.inputs) {
        const edge = incomingEdge(node.id, port.id, snapshot);
        if (!edge) throw new Error(`"${port.label}" is not connected.`);
        const view = record.viewMap.get(edge.from)?.[edge.fromPort];
        if (!view) throw new Error("The connected node did not produce anything.");
        inputs[port.id] = view;
        crsSeen.add(record.crsByNode.get(edge.from) || LONLAT);
      }
      if (crsSeen.size > 1)
        throw new Error(`Its inputs are in different coordinate systems (${[...crsSeen].join(", ")}).`);
      const incomingCrs = [...crsSeen][0] || LONLAT;
      if (transformer.needs.lonLat && !isLonLatCode(incomingCrs)) {
        throw new Error(
          `${node.type} works in longitude/latitude, but its input is in ${incomingCrs}. ` +
            `Reproject back to ${LONLAT} before it.`,
        );
      }
      const prefix = `${namespace}_g${record.gen}`;
      const ctx = {
        nodeId: node.id,
        nodeType: node.type,
        legacyNodeId: `${prefix}_${node.id}`,
        params: structuredClone(node.params),
        inputs,
        incomingCrs,
        schemas: null,
        rowCount: null,
        source: null,
        state: {},
        signal,
        engine,
        sources: { get: (id) => sources.get(id), relation: sourceRelation },
      };
      if (transformer.needs.schema) {
        ctx.schemas = {};
        for (const [port, view] of Object.entries(inputs)) {
          const described = (await c.query(`DESCRIBE ${view}`)).toArray().map((row) => row.toJSON());
          ctx.schemas[port] = described.map((row) => ({
            name: row.column_name,
            type: String(row.column_type).toUpperCase(),
          }));
        }
      }
      if (transformer.needs.rowCount) {
        const first = inputs[transformer.inputs[0].id];
        const counted = (await c.query(`SELECT count(*) AS n FROM ${first}`)).toArray()[0].toJSON();
        ctx.rowCount = Number(counted.n ?? 0);
        ctx.source = upstreamSource(node.id, sources, snapshot);
      }
      const { statements, crs } = await runNode(transformer, ctx, {
        prefix,
        owned,
        conn: c,
        outputs,
        qid,
        qlit,
        limits,
      });
      // Publish this node's views atomically.
      await c.query("BEGIN TRANSACTION");
      const produced = {};
      try {
        for (const [port, sql] of Object.entries(statements)) {
          const name = `${prefix}_${node.id}_${port}`;
          await c.query(`CREATE VIEW ${name} AS ${sql}`);
          produced[port] = name;
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      }
      owned.views.push(...Object.values(produced));
      record.views.push(...owned.views);
      record.tables.push(...owned.tables);
      record.viewMap.set(node.id, produced);
      record.crsByNode.set(node.id, crs);
      record.states.set(node.id, { status: "ok" });
    } catch (err) {
      if (err instanceof AbortError || signal.aborted) {
        for (const table of owned.tables.reverse()) await c.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
        throw new AbortError();
      }
      // Rule (b): a failed node's own resources go at once.
      for (const table of owned.tables.reverse()) await c.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      record.states.set(node.id, { status: "error", message: err.message || String(err), code: err.code || null });
    }
  }

  function notifyIdle() {
    if (running || pending) return;
    for (const wake of idleWaiters.splice(0)) wake();
  }

  function startNext() {
    if (running || !pending || disposed) return;
    const waiters = pending.waiters;
    pending = null;
    const controller = new AbortController();
    const promise = compileOnce(controller.signal).then(
      (record) => {
        for (const w of waiters) w.resolve(result(record));
      },
      (err) => {
        if (err instanceof AbortError) {
          // Superseded: the waiters ride on the next compile.
          if (!pending) pending = { waiters: [] };
          pending.waiters.push(...waiters);
        } else {
          for (const w of waiters) w.reject(err);
        }
      },
    );
    running = { controller, promise };
    promise.finally(() => {
      running = null;
      startNext();
      notifyIdle();
    });
  }

  function result(record) {
    return {
      gen: record.gen,
      views: record.viewMap,
      crsByNode: record.crsByNode,
      states: record.states,
      error: record.error,
    };
  }

  // After an engine restart every relation and connection is gone: start from nothing.
  // Only the main engine restarts; an isolated one is simply thrown away.
  onEngineRestart(() => {
    if (engine !== mainEngine) return;
    running?.controller.abort();
    connection = null;
    current = null;
    retired.clear();
    wakeBackpressure();
  });

  return {
    namespace,
    /** Ask for a compile. Latest wins: a running compile is aborted, and only the newest request runs. */
    compile() {
      if (disposed) return Promise.reject(new Error("This compiler has been disposed."));
      return new Promise((resolve, reject) => {
        if (!pending) pending = { waiters: [] };
        pending.waiters.push({ resolve, reject });
        running?.controller.abort();
        wakeBackpressure();
        startNext();
      });
    },
    /** A lease on the latest completed generation. Release it when the read is done. */
    acquire() {
      return lease(current);
    },
    /** Resolves when nothing is queued or running. */
    settled() {
      if (!running && !pending) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    /** Stop taking leases; drop every generation once its leases end, then close the connection. */
    async dispose() {
      disposed = true;
      pending = null;
      running?.controller.abort();
      await running?.promise.catch(() => {});
      if (current) retired.add(current);
      current = null;
      await dropRetiredUnleased();
      const closeWhenEmpty = async () => {
        if (retired.size) return setTimeout(closeWhenEmpty, 50);
        await connection?.close().catch(() => {});
        connection = null;
      };
      closeWhenEmpty();
    },
    /** For tests: which generations exist and how many leases each holds. */
    inspect() {
      return {
        current: current ? { gen: current.gen, leases: current.leases } : null,
        retired: [...retired].map((r) => ({ gen: r.gen, leases: r.leases })),
      };
    },
  };
}

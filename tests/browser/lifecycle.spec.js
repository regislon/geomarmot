/*
 * The compiler's lifecycle (docs/transformer-api.md, "Generations"): leases,
 * retirement, backpressure, aborts, failed compiles, and two compilers at once.
 * Each test drives its own compiler over its own graph, in its own namespace.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
  await h.page.evaluate(() => {
    const { defineTransformer, registerForTests, duck } = window.__geomarmotInternals;
    const out = [{ id: "output", label: "Output" }];
    // A source of n rows.
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "LcRange",
        group: "Test",
        summary: "Test: n rows.",
        outputs: out,
        params: [{ id: "n", label: "n", kind: "number" }],
        sql: (ctx) => ({ output: `SELECT range AS i FROM range(${Number(ctx.params.n ?? 3)})` }),
      }),
    );
    // Materialises its input in prepare, optionally slowly and abortably, optionally failing at a stage.
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "LcTable",
        group: "Test",
        summary: "Test: copies its input into a prepare table.",
        inputs: [{ id: "input", label: "Input" }],
        outputs: (params) => (params.twoPorts ? [...out, { id: "second", label: "Second" }] : out),
        params: [
          { id: "fail", label: "fail", kind: "string" },
          { id: "delayMs", label: "delay", kind: "number" },
          { id: "twoPorts", label: "two", kind: "string" },
        ],
        prepare: async (ctx) => {
          const table = ctx.tableName("copy");
          ctx.state.table = table;
          await duck.exec(`CREATE TABLE ${table} AS SELECT * FROM ${ctx.inputs.input}`);
          const until = Date.now() + Number(ctx.params.delayMs || 0);
          while (Date.now() < until) {
            if (ctx.signal.aborted) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          if (ctx.params.fail === "prepare") throw new Error("failed in prepare");
        },
        sql: (ctx) => {
          if (ctx.params.fail === "sql") throw new Error("failed in sql");
          if (ctx.params.fail === "unallocated") ctx.tableName("never");
          const ports = { output: `SELECT * FROM ${ctx.state.table}` };
          if (ctx.params.twoPorts)
            ports.second = ctx.params.fail === "view" ? "SELECT * FROM no_such_relation" : `SELECT 1 AS x`;
          return ports;
        },
        check: async (ctx) => {
          if (ctx.params.fail === "check") throw new Error("failed in check");
        },
      }),
    );
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "LcMutate",
        group: "Test",
        summary: "Test: tries to change its params and records ctx.state.",
        inputs: [{ id: "input", label: "Input" }],
        outputs: out,
        params: [{ id: "x", label: "x", kind: "string" }],
        sql: (ctx) => {
          window.__lcStates = [...(window.__lcStates || []), Object.keys(ctx.state).length];
          ctx.state.seen = true;
          ctx.params.x = "changed";
          return { output: `SELECT * FROM ${ctx.inputs.input}` };
        },
      }),
    );
    window.__lc = {
      make(ns) {
        const { createCompiler, sources } = window.__geomarmotInternals;
        const g = { nodes: [], edges: [] };
        const compiler = createCompiler({ namespace: ns, getGraph: () => g, getSources: () => sources.sources });
        return { g, compiler };
      },
      async relations(ns) {
        const views = await duck.query(
          `SELECT view_name AS n FROM duckdb_views() WHERE view_name LIKE '${ns}\\_%' ESCAPE '\\'`,
        );
        const tables = await duck.query(
          `SELECT table_name AS n FROM duckdb_tables() WHERE table_name LIKE '${ns}\\_%' ESCAPE '\\'`,
        );
        return { views: views.map((r) => r.n).sort(), tables: tables.map((r) => r.n).sort() };
      },
      gens(names) {
        return [...new Set(names.map((n) => n.split("_")[1]))].sort();
      },
    };
  });
});
test.afterAll(async () => h?.server.close());

const run = (fn, arg) => h.page.evaluate(fn, arg);

test("a read that started before an edit finishes on its own generation, which is dropped after release", async () => {
  const result = await run(async () => {
    const { g, compiler } = window.__lc.make("lca");
    g.nodes.push({ id: "n1", type: "LcRange", params: { n: 5 } }, { id: "n2", type: "LcTable", params: {} });
    g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    await compiler.compile();
    const lease = compiler.acquire();
    const oldView = lease.views.get("n2").output;
    g.nodes[0].params.n = 7;
    await compiler.compile();
    const during = await window.__lc.relations("lca");
    const rows = await window.__geomarmotInternals.duck.query(`SELECT count(*) AS c FROM ${oldView}`);
    lease.release();
    await new Promise((r) => setTimeout(r, 50));
    const after = await window.__lc.relations("lca");
    const fresh = compiler.acquire();
    const newRows = await window.__geomarmotInternals.duck.query(
      `SELECT count(*) AS c FROM ${fresh.views.get("n2").output}`,
    );
    fresh.release();
    return {
      during: window.__lc.gens(during.views),
      oldCount: rows[0].c,
      after: window.__lc.gens(after.views),
      newCount: newRows[0].c,
    };
  });
  expect(result.during).toEqual(["g1", "g2"]);
  expect(result.oldCount).toBe(5);
  expect(result.after).toEqual(["g2"]);
  expect(result.newCount).toBe(7);
});

test("backpressure: with a leased retired generation, a new compile creates nothing until it is released", async () => {
  const result = await run(async () => {
    const { g, compiler } = window.__lc.make("lcb");
    g.nodes.push({ id: "n1", type: "LcRange", params: { n: 2 } }, { id: "n2", type: "LcTable", params: {} });
    g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    await compiler.compile(); // g1
    const held = compiler.acquire();
    await compiler.compile(); // g2 current, g1 retired + leased
    const third = compiler.compile(); // must wait before allocating g3
    await new Promise((r) => setTimeout(r, 300));
    const waiting = await window.__lc.relations("lcb");
    held.release();
    await third;
    const done = await window.__lc.relations("lcb");
    return {
      waiting: window.__lc.gens([...waiting.views, ...waiting.tables]),
      done: window.__lc.gens([...done.views, ...done.tables]),
    };
  });
  expect(result.waiting).toEqual(["g1", "g2"]);
  expect(result.done).toEqual(["g3"]);
});

test("a burst of edits ends in one final compile with nothing leaked", async () => {
  const result = await run(async () => {
    const { g, compiler } = window.__lc.make("lcc");
    g.nodes.push(
      { id: "n1", type: "LcRange", params: { n: 1 } },
      { id: "n2", type: "LcTable", params: { delayMs: 30 } },
    );
    g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    const all = [];
    for (let k = 1; k <= 10; k++) {
      g.nodes[0].params.n = k;
      all.push(compiler.compile());
    }
    const results = await Promise.all(all);
    const lease = compiler.acquire();
    const rows = await window.__geomarmotInternals.duck.query(
      `SELECT count(*) AS c FROM ${lease.views.get("n2").output}`,
    );
    lease.release();
    const rel = await window.__lc.relations("lcc");
    return {
      gens: [...new Set(results.map((r) => r.gen))],
      count: rows[0].c,
      rel: window.__lc.gens([...rel.views, ...rel.tables]),
    };
  });
  expect(result.gens.length).toBe(1);
  expect(result.count).toBe(10);
  expect(result.rel.length).toBe(1);
});

test("an abort during prepare leaves no tables, and a partial generation is never leased", async () => {
  const result = await run(async () => {
    const { g, compiler } = window.__lc.make("lcd");
    g.nodes.push(
      { id: "n1", type: "LcRange", params: { n: 1 } },
      { id: "n2", type: "LcTable", params: { delayMs: 2000 } },
    );
    g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    const first = compiler.compile();
    await new Promise((r) => setTimeout(r, 150));
    g.nodes[1].params.delayMs = 0;
    const t0 = performance.now();
    const second = compiler.compile(); // aborts the slow one
    const [a, b] = await Promise.all([first, second]);
    const elapsed = performance.now() - t0;
    const rel = await window.__lc.relations("lcd");
    return { sameGen: a.gen === b.gen, elapsed, gens: window.__lc.gens([...rel.views, ...rel.tables]) };
  });
  expect(result.sameGen).toBe(true);
  expect(result.elapsed).toBeLessThan(1500);
  expect(result.gens.length).toBe(1);
});

for (const stage of ["prepare", "sql", "check", "view", "unallocated"]) {
  test(`a node failing in ${stage} leaves none of its own resources; downstream is blocked`, async () => {
    const result = await run(async (stage) => {
      const ns = `lce${stage.slice(0, 3)}`;
      const { g, compiler } = window.__lc.make(ns);
      g.nodes.push(
        { id: "n1", type: "LcRange", params: { n: 2 } },
        { id: "n2", type: "LcTable", params: { fail: stage, twoPorts: stage === "view" ? "yes" : "" } },
        { id: "n3", type: "LcTable", params: {} },
      );
      g.edges.push(
        { id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" },
        { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "input" },
      );
      const res = await compiler.compile();
      const rel = await window.__lc.relations(ns);
      return {
        states: Object.fromEntries([...res.states].map(([k, v]) => [k, v.status])),
        n2Resources: [...rel.views, ...rel.tables].filter((n) => n.includes("_n2_")),
        n1View: Boolean(res.views.get("n1")),
        error: res.error?.message || "",
      };
    }, stage);
    expect(result.states).toEqual({ n1: "ok", n2: "error", n3: "blocked" });
    expect(result.n2Resources).toEqual([]);
    expect(result.n1View).toBe(true);
    if (stage === "unallocated") expect(result.error).toContain("was not allocated in prepare()");
  });
}

test("a hook cannot change the node's params, and ctx.state starts empty every compile", async () => {
  const result = await run(async () => {
    window.__lcStates = [];
    const { g, compiler } = window.__lc.make("lcf");
    g.nodes.push(
      { id: "n1", type: "LcRange", params: { n: 1 } },
      { id: "n2", type: "LcMutate", params: { x: "original" } },
    );
    g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    await compiler.compile();
    await compiler.compile();
    return { x: g.nodes[1].params.x, states: window.__lcStates };
  });
  expect(result.x).toBe("original");
  expect(result.states).toEqual([0, 0]);
});

test("inputs in different coordinate systems are refused", async () => {
  const result = await run(async () => {
    const { defineTransformer, registerForTests } = window.__geomarmotInternals;
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "LcTwo",
        group: "Test",
        summary: "Test: two inputs.",
        inputs: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        outputs: [{ id: "output", label: "Output" }],
        sql: (ctx) => ({ output: `SELECT * FROM ${ctx.inputs.a}` }),
      }),
    );
    const { g, compiler } = window.__lc.make("lcg");
    g.nodes.push(
      { id: "n1", type: "FixtureSource", params: { table: "lc_none", crs: "EPSG:4326" } },
      { id: "n2", type: "FixtureSource", params: { table: "lc_none", crs: "EPSG:2056" } },
      { id: "n3", type: "LcTwo", params: {} },
    );
    g.edges.push(
      { id: "e1", from: "n1", fromPort: "output", to: "n3", toPort: "a" },
      { id: "e2", from: "n2", fromPort: "output", to: "n3", toPort: "b" },
    );
    await window.__geomarmotInternals.duck.exec("CREATE OR REPLACE TABLE lc_none (i INTEGER)");
    const res = await compiler.compile();
    return res.states.get("n3");
  });
  expect(result.status).toBe("error");
  expect(result.message).toContain("different coordinate systems");
});

test("two compilers compile at the same time without touching each other", async () => {
  const result = await run(async () => {
    const a = window.__lc.make("lch1");
    const b = window.__lc.make("lch2");
    for (const { g } of [a, b]) {
      g.nodes.push(
        { id: "n1", type: "LcRange", params: { n: 3 } },
        { id: "n2", type: "LcTable", params: { delayMs: 100 } },
      );
      g.edges.push({ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" });
    }
    const [ra, rb] = await Promise.all([a.compiler.compile(), b.compiler.compile()]);
    await a.compiler.dispose();
    await new Promise((r) => setTimeout(r, 100));
    const left = await window.__lc.relations("lch1");
    const right = await window.__lc.relations("lch2");
    return {
      ok: ra.states.get("n2").status === "ok" && rb.states.get("n2").status === "ok",
      left,
      rightCount: right.views.length,
    };
  });
  expect(result.ok).toBe(true);
  expect(result.left).toEqual({ views: [], tables: [] });
  expect(result.rightCount).toBe(2);
});

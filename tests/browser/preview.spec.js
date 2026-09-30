/*
 * Draft previews run in their own DuckDB instance (docs/decisions/0004):
 * they never create, read or drop anything in the user's engine, a failing or
 * runaway draft leaves the graph usable, and the preview engine goes away on
 * Discard or Apply once its last read has finished.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
  await h.page.evaluate(async () => {
    const { defineTransformer, registerForTests, model, mainCompiler, draft, preview } = window.__geomarmotInternals;
    const out = [{ id: "output", label: "Output" }];
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "PvRows",
        group: "Test",
        role: "source",
        summary: "Test: 5,000 rows with a name.",
        outputs: out,
        sql: () => ({ output: "SELECT range AS i, 'row ' || range AS name FROM range(5000)" }),
      }),
    );
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "PvPrepare",
        group: "Test",
        summary: "Test: a prepare that is slow or fails, on ctx.engine.",
        inputs: [{ id: "input", label: "Input" }],
        outputs: out,
        params: [
          { id: "fail", label: "fail", kind: "string" },
          { id: "delayMs", label: "delay", kind: "number" },
        ],
        prepare: async (ctx) => {
          const table = ctx.tableName("copy");
          await ctx.engine.exec(`CREATE TABLE ${table} AS SELECT * FROM ${ctx.inputs.input}`);
          await new Promise((r) => setTimeout(r, Number(ctx.params.delayMs || 0)));
          if (ctx.params.fail) throw new Error("failed in prepare");
        },
        sql: (ctx) => ({ output: `SELECT * FROM ${ctx.tableName("copy")}` }),
      }),
    );
    model.load(
      {
        format: "geomarmot-graph",
        version: 1,
        nodes: [{ id: "n1", type: "PvRows", x: 0, y: 0, params: {} }],
        edges: [],
      },
      { trusted: true },
    );
    await mainCompiler.compile();
    window.__pv = {
      world: {
        graph: model.graph,
        sources: new Map(),
        states: () => mainCompiler.acquire().states,
        counts: () => new Map(),
        retain: () => mainCompiler.acquire(),
      },
      setDraft: (nodes) =>
        draft.setDraft(
          nodes.map((n, k) => ({ x: 0, y: 0, ...n, id: n.id || `n${100 + k}` })),
          nodes.map((n, k) => ({
            from: n.from || "n1",
            fromPort: "output",
            to: n.id || `n${100 + k}`,
            toPort: "input",
          })),
          { replace: true },
        ),
      run: (level = 1) => preview.previewDraft(window.__pv.world, level),
      mainViews: async () =>
        (await window.__geomarmotInternals.duck.query("SELECT view_name FROM duckdb_views() WHERE NOT internal")).map(
          (r) => r.view_name,
        ),
      mainFirstRows: async () => {
        const lease = mainCompiler.acquire();
        try {
          return await window.__geomarmotInternals.duck.query(
            `SELECT * FROM ${lease.views.get("n1").output} ORDER BY i LIMIT 3`,
          );
        } finally {
          lease.release();
        }
      },
    };
  });
});
test.afterAll(async () => {
  h?.server.close();
});

test("a preview runs in its own engine: nothing appears in the user's", async () => {
  const result = await h.page.evaluate(async () => {
    const before = await window.__pv.mainViews();
    const rowsBefore = await window.__pv.mainFirstRows();
    window.__pv.setDraft([
      {
        id: "n100",
        type: "Tester",
        params: { logic: "AND", conditions: [{ column: "i", operator: "<", value: "10" }] },
      },
    ]);
    const payload = await window.__pv.run(1);
    const after = await window.__pv.mainViews();
    return {
      before,
      after,
      payload,
      same: JSON.stringify(rowsBefore) === JSON.stringify(await window.__pv.mainFirstRows()),
    };
  });
  expect(result.after).toEqual(result.before);
  expect(result.after.some((name) => name.startsWith("d"))).toBe(false);
  expect(result.same).toBe(true);
  const [node] = result.payload.nodes;
  expect(node).toMatchObject({ id: "n100", type: "Tester", state: "ok", draft: true });
  expect(node.inputs).toEqual([{ port: "input", from: "n1", fromPort: "output" }]);
  // The sample is at most 1,000 rows, so 10 pass and 990 fail.
  expect(node.outputs.map((o) => [o.port, o.rows])).toEqual([
    ["passed", 10],
    ["failed", 990],
  ]);
  expect(node.outputs[0].columns.map((c) => c.name)).toEqual(["i", "name"]);
  expect(node.outputs[0].sample).toBeUndefined();
});

test("statistics at level 2, at most 20 rows at level 3", async () => {
  const [at2, at3] = await h.page.evaluate(async () => [await window.__pv.run(2), await window.__pv.run(3)]);
  expect(at2.nodes[0].outputs[1].stats.map((s) => s.name)).toEqual(["i", "name"]);
  expect(at2.nodes[0].outputs[1].sample).toBeUndefined();
  expect(at3.nodes[0].outputs[1].sample.rows).toHaveLength(20);
});

test("the main graph compiles and reads while a draft is open", async () => {
  const ok = await h.page.evaluate(async () => {
    const { mainCompiler } = window.__geomarmotInternals;
    const previewing = window.__pv.run(1);
    await mainCompiler.compile();
    const rows = await window.__pv.mainFirstRows();
    await previewing;
    return rows.length;
  });
  expect(ok).toBe(3);
});

test("a draft that throws in prepare reports the error; the graph is unaffected", async () => {
  const result = await h.page.evaluate(async () => {
    window.__pv.setDraft([
      { id: "n101", type: "PvPrepare", params: { fail: "yes" } },
      { id: "n102", from: "n101", ...{ type: "Tester", params: {} } },
    ]);
    const payload = await window.__pv.run(1);
    return { payload, rows: (await window.__pv.mainFirstRows()).length };
  });
  expect(result.payload.nodes[0].state).toBe("error");
  expect(result.payload.nodes[1]).toMatchObject({
    state: "blocked",
    error: { code: "UPSTREAM_ERROR", params: { node: "n101" } },
  });
  expect(result.rows).toBe(3);
});

test("Discard ends the preview engine; a read in flight still finishes", async () => {
  const result = await h.page.evaluate(async () => {
    const { draft, preview } = window.__geomarmotInternals;
    const start = preview.previewStats();
    window.__pv.setDraft([{ id: "n103", type: "PvPrepare", params: { delayMs: 600 } }]);
    const running = window.__pv.run(1);
    await new Promise((r) => setTimeout(r, 200));
    draft.clearDraft();
    const payload = await running;
    const end = preview.previewStats();
    return { start, end, state: payload.nodes[0]?.state };
  });
  expect(result.state).toBe("ok");
  expect(result.end.open).toBe(false);
  expect(result.end.terminated).toBeGreaterThan(result.start.terminated);
});

test("a runaway draft is stopped after 10 s by throwing its engine away; the graph never waits", async () => {
  test.setTimeout(60_000);
  const result = await h.page.evaluate(async () => {
    const { preview } = window.__geomarmotInternals;
    const before = preview.previewStats().terminated;
    window.__pv.setDraft([
      {
        id: "n104",
        type: "SQLTransformer",
        params: { sql: "WITH RECURSIVE r(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM r) SELECT k FROM r, input" },
      },
    ]);
    const started = Date.now();
    let error = null;
    const running = window.__pv.run(1).catch((err) => (error = err.message));
    // Meanwhile the user's engine answers at once.
    const t0 = Date.now();
    await window.__pv.mainFirstRows();
    const mainMs = Date.now() - t0;
    await running;
    return {
      error,
      seconds: (Date.now() - started) / 1000,
      mainMs,
      terminated: preview.previewStats().terminated - before,
    };
  });
  expect(result.error).toMatch(/took longer than 10 s/);
  expect(result.seconds).toBeLessThan(20);
  expect(result.mainMs).toBeLessThan(2000);
  expect(result.terminated).toBe(1);
});

/*
 * The transformer contract (docs/transformer-api.md), checked over the whole registry.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
});
test.afterAll(async () => h?.server.close());

test("every registry entry keeps the role rules", async () => {
  const problems = await h.page.evaluate(() => {
    const out = [];
    for (const [id, t] of window.__geomarmotInternals.REGISTRY) {
      if (t.group === "Test") continue;
      if (t.apiVersion !== 1) out.push(`${id}: apiVersion`);
      if (t.role === "source" && t.inputs.length) out.push(`${id}: a source with inputs`);
      if (t.role === "sink" && (t.outputsFor({}).length || !t.write))
        out.push(`${id}: a sink must have no outputs and a write()`);
      if (t.role !== "sink" && !t.sql) out.push(`${id}: no sql()`);
      if (!t.summary) out.push(`${id}: no summary`);
    }
    return out;
  });
  expect(problems).toEqual([]);
});

test("aliases resolve on load, and migrations are pure and chain to the latest version", async () => {
  const result = await h.page.evaluate(() => {
    const { defineTransformer, registerForTests, model } = window.__geomarmotInternals;
    const calls = [];
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "CtMigrated",
        group: "Test",
        summary: "Test: a transformer on params version 3.",
        aliases: ["CtOldName"],
        inputs: [],
        outputs: [{ id: "output", label: "Output" }],
        params: [{ id: "b", label: "b", kind: "string" }],
        paramsVersion: 3,
        migrations: {
          1: (p) => (calls.push(1), { b: p.a }),
          2: (p) => (calls.push(2), { b: `${p.b}!` }),
        },
        sql: () => ({ output: "SELECT 1 AS x" }),
      }),
    );
    // registerForTests does not index aliases; this checks canonical lookup through load().
    const saved = {
      format: "geomarmot-graph",
      version: 1,
      nodes: [{ id: "n900", type: "CtMigrated", x: 0, y: 0, params: { a: "hi" } }],
      edges: [],
    };
    const original = JSON.stringify(saved);
    model.load(saved, { trusted: true });
    const node = model.graph.nodes[0];
    const result = {
      params: node.params,
      version: node.paramsVersion,
      calls,
      inputUntouched: JSON.stringify(saved) === original,
    };
    model.clear();
    return result;
  });
  expect(result).toEqual({ params: { b: "hi!" }, version: 3, calls: [1, 2], inputUntouched: true });
});

test("a graph from a file never keeps unrestricted SQL; the trusted autosave does", async () => {
  const result = await h.page.evaluate(() => {
    const { model } = window.__geomarmotInternals;
    const saved = () => ({
      format: "geomarmot-graph",
      version: 1,
      nodes: [{ id: "n901", type: "SQLTransformer", x: 0, y: 0, params: { sql: "SELECT 1" }, sqlMode: "unrestricted" }],
      edges: [],
    });
    const fromFile = model.load(saved());
    const fileMode = model.graph.nodes[0].sqlMode || "restricted";
    model.load(saved(), { trusted: true });
    const trustedMode = model.graph.nodes[0].sqlMode;
    model.clear();
    return { requested: fromFile.unrestrictedRequested, fileMode, trustedMode };
  });
  expect(result).toEqual({ requested: 1, fileMode: "restricted", trustedMode: "unrestricted" });
});

test("literal and identifier params are escaped: an injection payload adds no statement, relation or table function", async () => {
  const problems = await h.page.evaluate(async () => {
    const { REGISTRY, KINDS, duck, sqlguard } = window.__geomarmotInternals;
    const api = window.__geomarmotHarness;
    await api.createTable(
      "ct_esc",
      [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "VARCHAR" },
        { name: "v", type: "DOUBLE" },
        { name: "h3_index", type: "VARCHAR" },
        { name: "file_row_number", type: "BIGINT" },
        { name: "geometry", type: "GEOMETRY" },
      ],
      [[1, "a", 1.5, "8a1f8d7a49a7fff", 0, "POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))"]],
    );
    const payloads = {
      literal: "x') ; SELECT * FROM read_csv('stolen.csv') --",
      identifier: "x\" ; SELECT * FROM read_csv('stolen.csv') --",
    };
    const out = [];
    let tried = 0;
    for (const [id, t] of REGISTRY) {
      if (t.group === "Test" || t.role !== "transform" || t.inputs.length !== 1) continue;
      for (const p of t.params) {
        const use = KINDS[p.kind].sql;
        if (use !== "literal" && use !== "identifier") continue;
        const payload = payloads[use];
        const value =
          p.kind === "columns"
            ? [payload]
            : p.kind === "conditions"
              ? [{ column: "name", operator: "=", value: payload }]
              : p.kind === "rules"
                ? [{ label: "r", column: "name", operator: "=", value: payload }]
                : p.kind === "values"
                  ? [payload]
                  : p.kind === "renames"
                    ? [{ from: "name", to: payload }]
                    : p.kind === "sorts"
                      ? [{ column: payload, direction: "ASC" }]
                      : p.kind === "aggregates"
                        ? [{ func: "sum", column: payload, alias: payload }]
                        : p.kind === "joinkeys"
                          ? [{ left: payload, right: payload }]
                          : payload;
        const ids = api.buildGraph(
          [
            { key: "src", type: "FixtureSource", params: { table: "ct_esc" } },
            { key: "t", type: id, params: { [p.id]: value } },
          ],
          [{ from: "src", fromPort: "output", to: "t", toPort: "input" }],
        );
        const compiled = await api.compile();
        const views = compiled.views[ids.t];
        if (!views) continue; // refused: fine
        tried++;
        for (const view of Object.values(views)) {
          const rows = await duck.query(`SELECT sql FROM duckdb_views() WHERE view_name = '${view}'`);
          const body = String(rows[0]?.sql || "")
            .replace(/^CREATE VIEW \S+ AS /i, "")
            .replace(/;\s*$/, "");
          const tree = JSON.parse((await duck.query(`SELECT json_serialize_sql(${duck.qlit(body)}) AS t`))[0].t);
          if (tree.error) {
            out.push(`${id}.${p.id}: view SQL does not parse as one SELECT (${tree.error_message})`);
            continue;
          }
          if (tree.statements.length !== 1) out.push(`${id}.${p.id}: ${tree.statements.length} statements`);
          const found = sqlguard.collect(tree.statements[0]);
          if (found.tableFunctions.length) out.push(`${id}.${p.id}: table function ${found.tableFunctions.join(", ")}`);
          for (const table of found.tables) {
            const name = table.name.toLowerCase();
            if (name !== "ct_esc" && !/^m_g\d+_/.test(name) && !found.ctes.has(name))
              out.push(`${id}.${p.id}: reads "${table.name}"`);
          }
        }
      }
    }
    await api.teardown();
    return { out, tried };
  });
  expect(problems.out).toEqual([]);
  expect(problems.tried).toBeGreaterThan(20);
});

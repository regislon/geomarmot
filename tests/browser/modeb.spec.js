/*
 * Generated transformers (Mode B): the spec checks, typed templates, call
 * steps, and the adversarial list from the plan. Everything here must be
 * refused or neutralised — at proposal, and again when a saved graph is
 * compiled.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";

let h;
test.beforeAll(async ({ browser }) => {
  h = await openHarness(browser);
  await h.page.evaluate(async () => {
    const { defineTransformer, registerForTests, createCompiler } = window.__geomarmotInternals;
    registerForTests(
      defineTransformer({
        apiVersion: 1,
        id: "MbRows",
        group: "Test",
        role: "source",
        summary: "Test: people with an age.",
        outputs: [{ id: "output", label: "Output" }],
        sql: () => ({
          output: "SELECT * FROM (VALUES (1, 'Ann', 34), (2, 'Bob', 17), (3, 'Cy''s', 61)) AS t(id, name, age)",
        }),
      }),
    );
    let n = 0;
    window.__mb = {
      spec: (overrides = {}) => ({
        id: "CustomAdults",
        name: "Adults",
        summary: "Keeps rows whose age is at least a threshold.",
        description: "Filters on an age column.",
        inputs: [{ id: "input", label: "Input", description: "Rows with an age." }],
        outputs: [{ id: "output", label: "Output", description: "Rows at or over the threshold.", from: "steps.keep" }],
        params: [
          {
            id: "age",
            label: "Age column",
            kind: "column",
            description: "The age column.",
            options: [],
            default_json: '"age"',
          },
          {
            id: "min",
            label: "Minimum",
            kind: "number",
            description: "The threshold.",
            options: [],
            default_json: "18",
          },
        ],
        steps: [
          {
            id: "keep",
            kind: "sql",
            template: "SELECT * FROM {{inputs.input}} WHERE {{params.age}} >= {{params.min}}",
            transformer: "",
            inputs: [],
            params_json: "",
          },
        ],
        ...overrides,
      }),
      step: (template) => ({ id: "keep", kind: "sql", template, transformer: "", inputs: [], params_json: "" }),
      validate: (spec) => window.__geomarmotInternals.spec.validateSpec(spec),
      install: (spec) => window.__geomarmotInternals.spec.installCustom(spec, 1, { persist: false }),
      /** Compile Source → the given node in a fresh namespace; return its state and rows. */
      compile: async (type, params = {}, { read = true } = {}) => {
        const graph = {
          nodes: [
            { id: "n1", type: "MbRows", x: 0, y: 0, params: {} },
            { id: "n2", type, x: 0, y: 0, params },
          ],
          edges: [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
        };
        const compiler = createCompiler({ namespace: `mb${++n}`, getGraph: () => graph, getSources: () => new Map() });
        await compiler.compile();
        const lease = compiler.acquire();
        try {
          const state = lease.states.get("n2");
          const view = lease.views.get("n2")?.output;
          const rows =
            view && read ? await window.__geomarmotInternals.duck.query(`SELECT * FROM ${view} ORDER BY 1`) : null;
          return {
            state,
            rows: rows && JSON.parse(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? Number(v) : v))),
          };
        } finally {
          lease.release();
          await compiler.dispose();
        }
      },
    };
    await window.__mb.install(window.__mb.spec());
  });
});
test.afterAll(async () => h?.server.close());

const run = (fn, arg) => h.page.evaluate(fn, arg);
const codes = (verdict) => verdict.problems.map((p) => p.error.code);

test("a valid spec installs, and its template runs with typed params", async () => {
  const result = await run(async () => {
    const installed = await window.__mb.install(window.__mb.spec());
    const defaults = await window.__mb.compile("CustomAdults", { age: "age", min: 18 });
    const sixty = await window.__mb.compile("CustomAdults", { age: "age", min: 60 });
    return { ok: installed.ok, defaults, sixty };
  });
  expect(result.ok).toBe(true);
  expect(result.defaults.state.status).toBe("ok");
  expect(result.defaults.rows.map((r) => r.name)).toEqual(["Ann", "Cy's"]);
  expect(result.sixty.rows.map((r) => r.name)).toEqual(["Cy's"]);
});

test("param values are rendered by kind, never spliced: quotes, comments and braces stay values", async () => {
  const result = await run(async () => {
    const spec = window.__mb.spec({
      id: "CustomNamed",
      params: [{ id: "who", label: "Name", kind: "string", description: "A name.", options: [], default_json: '"x"' }],
      steps: [window.__mb.step("SELECT * FROM {{inputs.input}} WHERE name = {{params.who}}")],
    });
    await window.__mb.install(spec);
    const out = {};
    for (const who of ["Cy's", "x' OR 1=1 --", "*/ SELECT 1 /*", "{{inputs.input}}"])
      out[who] = await window.__mb.compile("CustomNamed", { who });
    const badNumber = await window.__mb.compile("CustomAdults", { age: "age", min: "18; DROP TABLE x" });
    const badColumn = await window.__mb.compile("CustomAdults", { age: "age\" FROM read_csv('x') --", min: 1 });
    return { out, badNumber, badColumn };
  });
  expect(result.out["Cy's"].rows.map((r) => r.id)).toEqual([3]);
  for (const who of ["x' OR 1=1 --", "*/ SELECT 1 /*", "{{inputs.input}}"]) {
    expect(result.out[who].state.status, who).toBe("ok");
    expect(result.out[who].rows, who).toEqual([]);
  }
  expect(result.badNumber.state.status).toBe("error");
  // A quoted identifier, however odd: it names a column that is not there.
  expect(result.badColumn.state.status).toBe("error");
  expect(result.badColumn.state.message).toMatch(/Referenced column .* not found/);
});

test.describe("templates the guard refuses", () => {
  const cases = [
    ["read_csv", "SELECT * FROM read_csv('/etc/passwd')"],
    ["st_read", "SELECT * FROM st_read('x.gpkg')"],
    ["a file as a table", "SELECT * FROM 'x.parquet'"],
    ["ATTACH", "ATTACH 'x.db' AS x"],
    ["COPY", "COPY (SELECT 1) TO 'x.csv'"],
    ["SET", "SET memory_limit = '1GB'"],
    ["a statement after ; in a comment", "SELECT * FROM {{inputs.input}}; -- ; \nSELECT * FROM read_csv('x')"],
    ["a statement after ; hidden by a string", "SELECT ';' AS a FROM {{inputs.input}}; SELECT 1"],
    ["a CTE shadowing an input", "WITH __gm_in_input AS (SELECT * FROM read_csv('x')) SELECT * FROM __gm_in_input"],
    ["a main-graph view", "SELECT * FROM m_g1_n1_output"],
    ["duckdb_settings()", "SELECT * FROM duckdb_settings()"],
    ["getenv", "SELECT getenv('HOME') AS h FROM {{inputs.input}}"],
    ["an undeclared input", "SELECT * FROM {{inputs.other}}"],
    ["stray braces", "SELECT * FROM {{inputs.input}} WHERE name = '{{'"],
    ["an unknown placeholder", "SELECT * FROM {{files.x}}"],
  ];
  for (const [name, template] of cases) {
    test(name, async () => {
      const verdict = await run(
        (t) => window.__mb.validate(window.__mb.spec({ id: "CustomBad", steps: [window.__mb.step(t)] })),
        template,
      );
      expect(verdict.ok, name).toBe(false);
      const expected = name === "an undeclared input" ? "UNKNOWN_PORT" : "SQL_FORBIDDEN_CONSTRUCT";
      expect(
        verdict.problems.map((p) => p.error.code),
        name,
      ).toEqual([expected]);
    });
  }
});

test("a recursive CTE that never ends is a valid SELECT, and the watchdog stops it", async () => {
  test.setTimeout(60_000);
  const result = await run(async () => {
    const spec = window.__mb.spec({
      id: "CustomForever",
      steps: [
        window.__mb.step(
          "WITH RECURSIVE r(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM r) SELECT k FROM r, {{inputs.input}}",
        ),
      ],
    });
    const installed = await window.__mb.install(spec);
    const { duck } = window.__geomarmotInternals;
    const compiled = await window.__mb.compile("CustomForever", {}, { read: false });
    // The compile only makes views; reading one is what runs away, and reads are watched.
    let error = null;
    const graph = {
      nodes: [
        { id: "n1", type: "MbRows", x: 0, y: 0, params: {} },
        { id: "n2", type: "CustomForever", x: 0, y: 0, params: {} },
      ],
      edges: [{ id: "e1", from: "n1", fromPort: "output", to: "n2", toPort: "input" }],
    };
    const compiler = window.__geomarmotInternals.createCompiler({
      namespace: "mbx",
      getGraph: () => graph,
      getSources: () => new Map(),
    });
    await compiler.compile();
    const lease = compiler.acquire();
    const started = Date.now();
    try {
      await duck.query(`SELECT count(*) FROM ${lease.views.get("n2").output}`, { timeoutMs: 3000 });
    } catch (err) {
      error = err.message;
    } finally {
      lease.release();
    }
    return { ok: installed.ok, state: compiled.state.status, error, seconds: (Date.now() - started) / 1000 };
  });
  expect(result.ok).toBe(true);
  expect(result.state).toBe("ok");
  expect(result.error).toMatch(/took longer than 3 s/);
  expect(result.seconds).toBeLessThan(10);
});

test("call steps: built-in and restricted only", async () => {
  const verdicts = await run(async () => {
    const call = (transformer, params_json, inputs = [{ port: "input", from: "inputs.input" }]) =>
      window.__mb.spec({
        id: "CustomCalls",
        outputs: [{ id: "output", label: "Out", description: "", from: "steps.c" }],
        steps: [{ id: "c", kind: "call", template: "", transformer, inputs, params_json }],
      });
    await window.__mb.install(window.__mb.spec({ id: "CustomInner" }));
    return {
      ok: await window.__mb.validate(
        call("Sorter", JSON.stringify({ sorts: [{ column: "{{params.age}}", direction: "DESC" }] })),
      ),
      generated: await window.__mb.validate(call("CustomInner", "{}")),
      reader: await window.__mb.validate(call("Reader", "{}", [])),
      writer: await window.__mb.validate(call("Writer", "{}")),
      sqlRead: await window.__mb.validate(
        call("SQLTransformer", JSON.stringify({ sql: "SELECT * FROM read_csv('x')" })),
      ),
      unwired: await window.__mb.validate(call("Sorter", "{}", [])),
      mode: await window.__mb.validate(
        call("SQLTransformer", JSON.stringify({ sql: "SELECT 1", sqlMode: "unrestricted" })),
      ),
      embedded: await window.__mb.validate(
        call("Tester", JSON.stringify({ conditions: [{ column: "age", operator: ">", value: "x{{params.min}}" }] })),
      ),
    };
  });
  expect(verdicts.ok.ok).toBe(true);
  expect(codes(verdicts.generated)).toContain("UNKNOWN_TRANSFORMER");
  expect(codes(verdicts.reader)).toContain("NOT_AI_USABLE");
  expect(codes(verdicts.writer)).toContain("NOT_AI_USABLE");
  expect(codes(verdicts.sqlRead)).toContain("SQL_FORBIDDEN_CONSTRUCT");
  expect(codes(verdicts.unwired)).toContain("PORT_NOT_CONNECTED");
  expect(codes(verdicts.mode)).toContain("INVALID_PARAMS");
  expect(codes(verdicts.embedded)).toContain("INVALID_INPUT");
});

test("a call step runs as a node, with this node's params passed through", async () => {
  const result = await run(async () => {
    const spec = window.__mb.spec({
      id: "CustomSorted",
      params: [
        { id: "by", label: "By", kind: "column", description: "Sort column.", options: [], default_json: '"age"' },
      ],
      outputs: [{ id: "output", label: "Out", description: "", from: "steps.top" }],
      steps: [
        {
          id: "s",
          kind: "call",
          template: "",
          transformer: "Sorter",
          inputs: [{ port: "input", from: "inputs.input" }],
          params_json: JSON.stringify({ sorts: [{ column: "{{params.by}}", direction: "DESC" }] }),
        },
        {
          id: "top",
          kind: "sql",
          template: "SELECT * FROM {{steps.s}} LIMIT 1",
          transformer: "",
          inputs: [],
          params_json: "",
        },
      ],
    });
    const installed = await window.__mb.install(spec);
    return {
      ok: installed.ok,
      problems: installed.problems,
      out: await window.__mb.compile("CustomSorted", { by: "age" }),
    };
  });
  expect(result.problems).toEqual([]);
  expect(result.out.rows.map((r) => r.name)).toEqual(["Cy's"]);
});

test("the bypass routes through Mode A are refused at proposal", async () => {
  const result = await run(async () => {
    const { intake, model } = window.__geomarmotInternals;
    model.load({ format: "geomarmot-graph", version: 1, nodes: [], edges: [] }, { trusted: true });
    const propose = (type, params) =>
      intake.intakeProposal(
        { nodes: [{ ref: "a", type, params_json: JSON.stringify(params) }], edges: [] },
        { graph: model.graph, levelReached: 1 },
      );
    const readCsv = "(SELECT count(*) FROM read_csv('/etc/passwd'))";
    return {
      create: await propose("AttributeCreator", { mode: "SQL query", sql: "SELECT *, 1 AS x FROM read_csv('x')" }),
      manager: await propose("AttributeManager", {
        actions: [{ action: "Set value", column: "a", spec: { kind: "SQL", sql: readCsv } }],
      }),
      vertex: await propose("VertexCreator", {
        mode: "Replace with Point",
        x: { kind: "SQL", sql: "(SELECT 1 FROM st_read('x.gpkg'))" },
        y: { kind: "Value", value: "1" },
      }),
      transformer: await propose("SQLTransformer", { sql: "SELECT * FROM read_csv('x')" }),
    };
  });
  for (const [name, verdict] of Object.entries(result)) {
    expect(verdict.ok, name).toBe(false);
    expect(verdict.problems[0].error.code, name).toBe("SQL_FORBIDDEN_CONSTRUCT");
  }
});

test("and again when a saved graph carrying them is compiled", async () => {
  const states = await run(async () => {
    const readCsv = "(SELECT count(*) FROM read_csv('/etc/passwd'))";
    return {
      manager: (
        await window.__mb.compile("AttributeManager", {
          actions: [{ action: "Set value", column: "name", spec: { kind: "SQL", sql: readCsv } }],
        })
      ).state,
      vertex: (
        await window.__mb.compile("VertexCreator", {
          mode: "Replace with Point",
          x: { kind: "SQL", sql: "(SELECT 1 FROM st_read('x.gpkg'))" },
          y: { kind: "Value", value: "1" },
        })
      ).state,
    };
  });
  expect(states.manager).toMatchObject({ status: "error", code: "SQL_FORBIDDEN_CONSTRUCT" });
  expect(states.vertex).toMatchObject({ status: "error", code: "SQL_FORBIDDEN_CONSTRUCT" });
});

test("a graph file whose generated transformer breaks the rules is refused", async () => {
  const refused = await run(async () => {
    const bad = window.__mb.spec({ id: "CustomSneaky", steps: [window.__mb.step("SELECT * FROM read_parquet('x')")] });
    return window.__geomarmotInternals.spec.installGraphCustoms({ custom: [{ spec: bad, level: 1 }] });
  });
  expect(refused).toEqual(["CustomSneaky"]);
});

/*
 * The SQL guard (docs/security.md, D7): restricted SQL may only read its inputs,
 * and SQL the guard refuses never reaches the engine.
 */

import { test, expect } from "@playwright/test";
import { openHarness } from "../harness/target.js";

let h;
const requests = [];
test.beforeAll(async ({ browser }) => {
  const files = new Map([["probe.csv", new TextEncoder().encode("a\n1\n")]]);
  h = await openHarness(browser, { files, onRequest: (req) => requests.push(req.url) });
});
test.afterAll(async () => h?.server.close());

const validate = (sql, context = "query") =>
  h.page.evaluate(({ sql, context }) => window.__geomarmotInternals.sqlguard.validate(sql, context), { sql, context });

const refused = [
  ["a file-reading table function", "SELECT * FROM read_csv('x.csv')"],
  ["GDAL", "SELECT * FROM st_read('a.gpkg')"],
  ["a replacement scan", "SELECT * FROM 'x.parquet'"],
  ["a table function hidden in a subquery", "SELECT input.*, (SELECT count(*) FROM read_parquet('y')) AS n FROM input"],
  ["glob in a set operation", "SELECT 1 AS a UNION ALL SELECT * FROM glob('*')"],
  ["a settings table function", "SELECT * FROM input, LATERAL (SELECT * FROM duckdb_settings())"],
  ["ATTACH", "ATTACH 'other.db'"],
  ["COPY", "COPY input TO 'out.csv'"],
  ["SET", "SET memory_limit = '1GB'"],
  ["PRAGMA", "PRAGMA version"],
  ["stacked statements", "SELECT input.*, 1 AS a FROM input; SELECT 2"],
  ["a statement hidden behind a comment", "SELECT 1 /* ; */ ; COPY input TO 'x'"],
  ["another node's view", "SELECT * FROM m_g1_n2_output"],
  ["a qualified relation", "SELECT * FROM main.secrets"],
  ["getenv", "SELECT getenv('HOME') AS h FROM input"],
  ["current_setting", "SELECT current_setting('threads') AS t FROM input"],
  ["DROP", "DROP TABLE input"],
];
for (const [what, sql] of refused) {
  test(`refuses ${what}`, async () => {
    const verdict = await validate(sql);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(false);
  });
}

const accepted = [
  ["a plain query", "SELECT input.*, v * 2 AS v2 FROM input"],
  ["its own CTE", "WITH t AS (SELECT id FROM input) SELECT * FROM t"],
  ["a recursive CTE", "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r"],
  ["spatial functions", "SELECT ST_AsText(ST_Point(1, 2)) AS p FROM input"],
  ["a trailing semicolon", "SELECT * FROM input;"],
];
for (const [what, sql] of accepted) {
  test(`accepts ${what}`, async () => {
    expect(await validate(sql)).toEqual({ ok: true });
  });
}

test("expressions: a function call is fine; a trailing comment cannot swallow the wrapper", async () => {
  expect(await validate("upper(name) || '!'", "expression")).toEqual({ ok: true });
  expect((await validate("1) FROM input; SELECT * FROM read_csv('x') --", "expression")).ok).toBe(false);
  expect((await validate("(SELECT count(*) FROM read_csv('x'))", "expression")).ok).toBe(false);
});

/** Build Fixture → T with params, compile, return T's state and whether the probe was fetched. */
async function compileWith(type, params, sqlMode) {
  requests.length = 0;
  const state = await h.page.evaluate(
    async ({ type, params, sqlMode }) => {
      const api = window.__geomarmotHarness;
      await api.createTable(
        "sg_in",
        [
          { name: "id", type: "INTEGER" },
          { name: "name", type: "VARCHAR" },
          { name: "geometry", type: "GEOMETRY" },
        ],
        [[1, "a", "POINT (0 0)"]],
      );
      const ids = api.buildGraph(
        [
          { key: "src", type: "FixtureSource", params: { table: "sg_in" } },
          { key: "t", type, params },
        ],
        [{ from: "src", fromPort: "output", to: "t", toPort: "input" }],
      );
      const { model } = window.__geomarmotInternals;
      if (sqlMode) model.nodeById(ids.t).sqlMode = sqlMode;
      const compiled = await api.compile();
      const out = compiled.states[ids.t];
      await api.teardown();
      return out;
    },
    { type, params, sqlMode },
  );
  return { state, fetched: requests.some((url) => url.includes("probe.csv")) };
}

const probe = () => `read_csv('${h.server.url}/__files/probe.csv')`;

test("refused SQL never reaches the engine; the same SQL, unrestricted, does", async () => {
  const sql = `SELECT input.*, (SELECT count(*) FROM ${probe()}) AS n FROM input`;
  const restricted = await compileWith("SQLTransformer", { sql });
  expect(restricted.state.status).toBe("error");
  expect(restricted.state.code).toBe("SQL_FORBIDDEN_CONSTRUCT");
  expect(restricted.fetched).toBe(false);
  const unrestricted = await compileWith("SQLTransformer", { sql }, "unrestricted");
  expect(unrestricted.state.status).toBe("ok");
  expect(unrestricted.fetched).toBe(true);
});

const bypasses = [
  ["SQLTransformer query", "SQLTransformer", () => ({ sql: `SELECT * FROM ${probe()}` })],
  [
    "AttributeCreator SQL mode",
    "AttributeCreator",
    () => ({ mode: "SQL query", sql: `SELECT input.*, (SELECT 1 FROM ${probe()}) AS x FROM input` }),
  ],
  [
    "AttributeCreator builder SQL value",
    "AttributeCreator",
    () => ({ mode: "Builder", creates: [{ name: "x", value: { kind: "SQL", sql: `(SELECT 1 FROM ${probe()})` } }] }),
  ],
  [
    "AttributeManager set-value SQL",
    "AttributeManager",
    () => ({
      actions: [{ action: "Set value", column: "name", spec: { kind: "SQL", sql: `(SELECT 'x' FROM ${probe()})` } }],
    }),
  ],
  [
    "VertexCreator X field",
    "VertexCreator",
    () => ({
      mode: "Replace with Point",
      x: { kind: "SQL", sql: `(SELECT 1 FROM ${probe()})` },
      y: { kind: "Value", type: "Number", value: "1" },
    }),
  ],
];
for (const [what, type, params] of bypasses) {
  test(`closes the bypass through ${what}`, async () => {
    const { state, fetched } = await compileWith(type, params());
    expect(state.status).toBe("error");
    expect(fetched).toBe(false);
  });
}

import { describe, test, expect } from "vitest";
import {
  classify,
  cell,
  errorPayload,
  gate,
  GateError,
  LIMITS,
  sampleRows,
  structured,
} from "../../app/src/ai/gate/index.js";
import { hashValue, leaves, recordAiParams, redactParams } from "../../app/src/ai/gate/origin.js";
import { paramsSchemaFor } from "../../app/src/ai/catalogue.js";

const CANARY = "CANARY-7f3a-Zürich";

describe("classify", () => {
  test("a conversion error keeps the type and drops the value", () => {
    const out = classify(`Conversion Error: Could not convert string '${CANARY}' to INT32`);
    expect(out).toEqual({
      code: "CONVERSION_FAILED",
      params: { type: "INT32" },
      message: "Some values could not be converted to INT32.",
    });
    expect(JSON.stringify(out)).not.toContain("CANARY");
  });

  test.each([
    ['Binder Error: Referenced column "popx" not found in FROM clause!', "COLUMN_NOT_FOUND", { column: "popx" }],
    ['Parser Error: syntax error at or near "FORM"', "SQL_SYNTAX", {}],
    ["Catalog Error: Scalar Function with name foo does not exist!", "FUNCTION_NOT_FOUND", { function: "foo" }],
    ["The query took longer than 30 s and was stopped.", "TIMEOUT", { count: 30 }],
    ['"Input" is not connected.', "PORT_NOT_CONNECTED", { port: "Input" }],
    ["Its inputs are in different coordinate systems (EPSG:4326, EPSG:2056).", "CRS_MISMATCH", {}],
    ["Out of Memory Error: failed to allocate", "OUT_OF_MEMORY", {}],
  ])("%s → %s", (message, code, params) => {
    expect(classify(message)).toMatchObject({ code, params });
  });

  test("guard refusals name the construct", () => {
    const out = classify({
      code: "SQL_FORBIDDEN_CONSTRUCT",
      message: "Table functions such as read_csv() are not allowed here: this SQL may only read its inputs.",
    });
    expect(out.params).toEqual({ construct: "read_csv", rule: "TABLE_FUNCTION" });
  });

  test("a blocked node says where the error is", () => {
    expect(classify({ status: "blocked", origin: "n3", message: "Blocked" })).toMatchObject({
      code: "UPSTREAM_ERROR",
      params: { node: "n3" },
    });
  });

  test("anything unrecognised is UNKNOWN_ERROR with no params", () => {
    expect(classify(`weird failure mentioning ${CANARY}`)).toEqual({
      code: "UNKNOWN_ERROR",
      params: {},
      message: expect.not.stringContaining("CANARY"),
    });
  });

  test("structured keeps only allowed, identifier-like params", () => {
    expect(structured("COLUMN_NOT_FOUND", { column: "a", secret: "x" }).params).toEqual({ column: "a" });
    expect(structured("COLUMN_NOT_FOUND", { column: "a'; DROP" }).params).toEqual({});
    expect(structured("NOPE").code).toBe("UNKNOWN_ERROR");
  });
});

describe("gate", () => {
  const port = (extra = {}) => ({
    port: "output",
    rows: 3,
    crs: "EPSG:4326",
    columns: [{ name: "v", type: "VARCHAR" }],
    ...extra,
  });
  const node = (outputs, error = null) => ({
    id: "n1",
    type: "Tester",
    params: {},
    state: "ok",
    error,
    inputs: [],
    outputs,
  });
  const stats = [
    { name: "v", min: "a", max: "z", nullShare: 0, distinct: 3, top: [{ value: "a", count: 2 }], extent: null },
  ];
  const sample = sampleRows([{ name: "v" }], [{ v: "a" }]);

  test("level 1 allows schema, refuses statistics and rows", () => {
    expect(gate("node", node([port()]), 1)).toBeTruthy();
    expect(() => gate("node", node([port({ stats })]), 1)).toThrow(GateError);
    expect(() => gate("node", node([port({ sample })]), 1)).toThrow(GateError);
  });

  test("level 2 allows statistics, refuses rows", () => {
    expect(gate("node", node([port({ stats })]), 2)).toBeTruthy();
    expect(() => gate("node", node([port({ stats, sample })]), 2)).toThrow(GateError);
  });

  test("level 3 allows rows, within the limits", () => {
    expect(gate("node", node([port({ stats, sample })]), 3)).toBeTruthy();
    const many = { columns: ["v"], rows: Array.from({ length: LIMITS.rows + 1 }, () => ["a"]) };
    expect(() => gate("node", node([port({ sample: many })]), 3)).toThrow(/more than 20/);
    const long = { columns: ["v"], rows: [["x".repeat(LIMITS.cellChars + 1)]] };
    expect(() => gate("node", node([port({ sample: long })]), 3)).toThrow(GateError);
  });

  test("top values are capped at 5 of 100 characters", () => {
    const six = [{ ...stats[0], top: Array.from({ length: 6 }, (_, k) => ({ value: `v${k}`, count: 1 })) }];
    expect(() => gate("node", node([port({ stats: six })]), 2)).toThrow(GateError);
    const long = [{ ...stats[0], top: [{ value: "x".repeat(101), count: 1 }] }];
    expect(() => gate("node", node([port({ stats: long })]), 2)).toThrow(GateError);
  });

  test("raw error text only at level 3, and cut to 500", () => {
    const raw = `Conversion Error: Could not convert string '${CANARY}' to INT32`;
    const at2 = errorPayload(raw, 2);
    expect(JSON.stringify(gate("error", { error: at2 }, 2))).not.toContain("CANARY");
    expect(() => gate("error", { error: { ...at2, raw } }, 2)).toThrow(GateError);
    const at3 = errorPayload("x".repeat(900), 3);
    expect(at3.raw.length).toBe(LIMITS.errorChars);
    expect(gate("error", { error: at3 }, 3)).toBeTruthy();
  });

  test("an extra field anywhere is refused, never stripped", () => {
    expect(() => gate("node", { ...node([port()]), note: "hi" }, 3)).toThrow(/not allowed/);
    expect(() => gate("node", node([port({ firstRows: [] })]), 3)).toThrow(/not allowed/);
  });

  test("a graph summary is typed per level", () => {
    const summary = { level: 1, sources: [], nodes: [node([port()])], edges: [] };
    expect(gate("graph", summary, 1)).toBeTruthy();
    expect(() => gate("graph", summary, 2)).toThrow(GateError);
  });

  test("cells are cut and made JSON-safe", () => {
    expect(cell(10n)).toBe("10");
    expect(cell("x".repeat(300)).length).toBe(LIMITS.cellChars);
    expect(cell(Number.NaN)).toBe("NaN");
  });
});

describe("param origin", () => {
  const written = {
    logic: "AND",
    conditions: [
      { column: "name", operator: "=", value: CANARY },
      { column: "pop", operator: ">", value: "5000" },
    ],
  };
  const fresh = () => recordAiParams({ params: structuredClone(written) }, written, 3);
  const schema = paramsSchemaFor("Tester");
  const opts = { schema, knownColumns: new Set(["name", "pop"]) };

  test("records every leaf the assistant wrote", () => {
    const origin = fresh().paramOrigin;
    expect(origin["conditions[0].value"]).toEqual({ by: "ai", level: 3, hash: hashValue(CANARY) });
    expect(Object.keys(origin)).toContain("logic");
  });

  test("values from above the level are redacted; enums and known columns are kept", () => {
    const out = redactParams(fresh(), 1, opts);
    expect(JSON.stringify(out)).not.toContain("CANARY");
    expect(out.conditions[0]).toEqual({
      column: "name",
      operator: "=",
      value: { redacted: "derived from data above the current level", kind: "string" },
    });
    expect(out.logic).toBe("AND");
  });

  test("nothing is redacted at the level it was written", () => {
    expect(redactParams(fresh(), 3, opts)).toEqual(written);
  });

  test("a value the user changes is theirs, and is sent", () => {
    const node = fresh();
    node.params.conditions[0].value = "Bern";
    expect(redactParams(node, 1, opts).conditions[0].value).toBe("Bern");
  });

  test("moving rows does not uncover a value", () => {
    const node = fresh();
    node.params.conditions = [{ column: "x", operator: "=", value: "new" }, ...node.params.conditions];
    expect(JSON.stringify(redactParams(node, 1, opts))).not.toContain("CANARY");
  });

  test("user params with no origin are sent as they are", () => {
    expect(redactParams({ params: written }, 1, opts)).toEqual(written);
  });

  test("leaves lists every primitive with its path", () => {
    expect(leaves({ a: [{ b: 1 }], c: "x" })).toEqual([
      { path: "a[0].b", value: 1 },
      { path: "c", value: "x" },
    ]);
  });
});

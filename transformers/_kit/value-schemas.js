// @ts-check
/*
 * What a parameter's value looks like, as JSON Schema (draft 2020-12).
 *
 * One schema per kind, built from the same lists the inspector offers, so a
 * value the inspector can produce always validates and one it cannot is
 * refused. The generated schemas/params.schema.json and the assistant's intake
 * both come from here (docs/params.md).
 *
 * Every property is optional: a node's params are merged over its defaults, and
 * a half-filled row is the normal state of a row being typed.
 */

import { FORMULA_OPERATORS, VALUE_KINDS, VALUE_TYPES } from "../../app/src/core/valuespec.js";
import { OPERATORS } from "./helpers.js";
import { optionValues } from "./params.js";

/** Longest text any single field may hold; SQL editors get more room. */
const TEXT = { type: "string", maxLength: 1000 };
const SQL_TEXT = { type: "string", maxLength: 20000 };
const LIST = 200;

const object = (properties) => ({ type: "object", additionalProperties: false, properties });
const rows = (item) => ({ type: "array", maxItems: LIST, items: item });

export const ACTION_KINDS = ["Set value", "Rename", "Copy to", "Create", "Remove"];
export const SORT_DIRECTIONS = ["ASC", "DESC"];
/** Kept in step with aggregator/index.js by a test, not imported: the kit must not import a transformer. */
export const AGGREGATE_KINDS = ["count", "sum", "min", "max", "mean", "median", "count distinct"];

const operand = object({
  kind: { enum: ["Attribute", "Value"] },
  column: TEXT,
  type: { enum: VALUE_TYPES },
  value: TEXT,
});

/** A value spec: a constant, an attribute, a two-operand formula, or SQL (an expression). */
export const VALUESPEC = object({
  kind: { enum: VALUE_KINDS },
  type: { enum: VALUE_TYPES },
  value: TEXT,
  column: TEXT,
  operator: { enum: FORMULA_OPERATORS },
  left: operand,
  right: operand,
  sql: SQL_TEXT,
});

const operatorEnum = { enum: Object.keys(OPERATORS) };

/** @type {Record<string, (spec: import("./params.js").ParamSpec) => object>} */
const BY_KIND = {
  string: () => TEXT,
  number: () => ({ anyOf: [{ type: "number" }, { type: "string", maxLength: 100 }] }),
  select: (spec) => {
    const values = optionValues(spec);
    // Options computed from the node (the Reader's layers, say) are only known at run time.
    return values.length ? { enum: values } : TEXT;
  },
  source: () => TEXT,
  column: () => TEXT,
  columns: () => rows(TEXT),
  valuespec: () => ({ $ref: "#/$defs/valuespec" }),
  conditions: () => rows(object({ column: TEXT, operator: operatorEnum, value: TEXT })),
  renames: () => rows(object({ from: TEXT, to: TEXT })),
  creates: () => rows(object({ name: TEXT, expression: SQL_TEXT })),
  valuerows: () => rows(object({ name: TEXT, value: { $ref: "#/$defs/valuespec" } })),
  actions: () =>
    rows(
      object({
        action: { enum: ACTION_KINDS },
        column: TEXT,
        target: TEXT,
        value: TEXT,
        spec: { $ref: "#/$defs/valuespec" },
      }),
    ),
  sorts: () => rows(object({ column: TEXT, direction: { enum: SORT_DIRECTIONS } })),
  aggregates: () => rows(object({ func: { enum: AGGREGATE_KINDS }, column: TEXT, alias: TEXT })),
  values: () => rows(TEXT),
  rules: () => rows(object({ label: TEXT, column: TEXT, operator: operatorEnum, value: TEXT })),
  joinkeys: () => rows(object({ left: TEXT, right: TEXT })),
  choices: (spec) => ({ type: "array", uniqueItems: true, items: { enum: spec.choices || [] } }),
  sqltext: () => SQL_TEXT,
  sqlcreate: () => SQL_TEXT,
};

/** The schema of one param's value. */
export function valueSchema(spec) {
  const build = BY_KIND[spec.kind];
  if (!build) throw new Error(`No value schema for param kind "${spec.kind}".`);
  return { description: spec.description || spec.label, ...build(spec) };
}

/** The schema of a whole params object for a transformer: its params, and nothing else. */
export function paramsSchema(transformer) {
  const properties = {};
  for (const spec of transformer.params) properties[spec.id] = valueSchema(spec);
  return { type: "object", additionalProperties: false, properties };
}

/** Shared definitions the per-kind schemas refer to. */
export const DEFS = { valuespec: VALUESPEC };

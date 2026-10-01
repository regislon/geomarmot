// @ts-check
/*
 * What may leave the browser, per payload type and data level.
 *
 * One schema per (type, level), every object closed (additionalProperties:
 * false). The gate validates each payload against its schema and refuses it
 * whole when anything is extra — it never strips, so a builder that attaches
 * sample rows at level 2 fails loudly in tests instead of quietly shipping.
 *
 *   level 1  names and types, counts, CRS, graph structure, user-entered params,
 *            structured errors
 *   level 2  + per-column statistics: min, max, null share, distinct count,
 *            extent, up to 5 top values of at most 100 characters
 *   level 3  + up to 20 sample or preview rows of at most 200 characters a
 *            cell, and raw error text of at most 500 characters
 */

import { ERROR_CODES, ERROR_PARAM_NAMES } from "./errors.js";
import transformerSchema from "../../../../schemas/transformer.schema.json" with { type: "json" };

export const LIMITS = Object.freeze({ topValues: 5, topValueChars: 100, rows: 20, cellChars: 200, errorChars: 500 });

const IDENT = { type: "string", maxLength: 200 };
const COUNT = { type: "integer", minimum: 0 };
const CRS = { type: ["string", "null"], maxLength: 100 };
const closed = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const list = (items, maxItems) => ({ type: "array", items, ...(maxItems !== undefined && { maxItems }) });
const scalar = (chars) => ({
  anyOf: [{ type: "string", maxLength: chars }, { type: "number" }, { type: "boolean" }, { type: "null" }],
});

const column = closed({ name: IDENT, type: { type: "string", maxLength: 100 } });

function errorSchema(level) {
  const params = {};
  for (const name of ERROR_PARAM_NAMES)
    params[name] =
      name === "count" ? { type: "number" } : { type: "string", maxLength: name === "problem" ? 300 : 100 };
  const properties = {
    code: { enum: ERROR_CODES },
    params: { type: "object", additionalProperties: false, properties: params },
    message: { type: "string", maxLength: 500 },
  };
  if (level >= 3) properties.raw = { type: "string", maxLength: LIMITS.errorChars };
  return closed(properties, ["code", "params", "message"]);
}

const stats = closed(
  {
    name: IDENT,
    min: scalar(LIMITS.topValueChars),
    max: scalar(LIMITS.topValueChars),
    nullShare: { type: "number", minimum: 0, maximum: 1 },
    distinct: COUNT,
    top: list(closed({ value: scalar(LIMITS.topValueChars), count: COUNT }), LIMITS.topValues),
    extent: { anyOf: [{ type: "null" }, list({ type: "number" }, 4)] },
  },
  ["name", "nullShare", "distinct"],
);

const rows = closed({
  columns: list(IDENT, 500),
  rows: list(list(scalar(LIMITS.cellChars), 500), LIMITS.rows),
});

/** A param value in a summary: the user's configuration, or a redaction marker. */
const PARAM_DEFS = {
  paramValue: {
    anyOf: [
      { type: "string", maxLength: 20000 },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
      { type: "array", maxItems: 500, items: { $ref: "#/$defs/paramValue" } },
      closed({
        redacted: { const: "derived from data above the current level" },
        kind: { type: "string", maxLength: 20 },
      }),
      { type: "object", additionalProperties: { $ref: "#/$defs/paramValue" } },
    ],
  },
};
const params = { type: "object", additionalProperties: { $ref: "#/$defs/paramValue" } };

function outputPort(level) {
  const properties = { port: IDENT, rows: { type: ["integer", "null"] }, crs: CRS, columns: list(column, 500) };
  if (level >= 2) properties.stats = list(stats, 500);
  if (level >= 3) properties.sample = rows;
  return closed(properties, ["port", "columns"]);
}

function nodeSchema(level) {
  return closed(
    {
      id: IDENT,
      type: IDENT,
      params,
      state: { enum: ["ok", "error", "blocked", "pending", "sink"] },
      error: { anyOf: [{ type: "null" }, errorSchema(level)] },
      inputs: list(closed({ port: IDENT, from: { type: ["string", "null"] }, fromPort: { type: ["string", "null"] } })),
      outputs: list(outputPort(level)),
      draft: { type: "boolean" },
      aiWritten: { type: "boolean" },
    },
    ["id", "type", "params", "state", "error", "inputs", "outputs"],
  );
}

const edge = closed({ from: IDENT, fromPort: IDENT, to: IDENT, toPort: IDENT });
const source = closed({
  id: IDENT,
  name: IDENT,
  format: IDENT,
  rows: COUNT,
  crs: CRS,
  columns: list(column, 500),
  layer: { type: ["string", "null"], maxLength: 200 },
});

const brief = closed({ id: IDENT, name: IDENT, group: IDENT, summary: { type: "string", maxLength: 200 } });

const BUILDERS = {
  /** search_transformers: static catalogue data. */
  search: () => closed({ results: list(brief, 50) }),
  /** describe_transformer: one catalogue entry, which is static. */
  transformer: () => transformerSchema,
  /** get_graph, and the summary that restarts a conversation. */
  graph: (level) =>
    closed(
      {
        level: { const: level },
        sources: list(source, 200),
        nodes: list(nodeSchema(level), 500),
        edges: list(edge, 2000),
      },
      ["level", "sources", "nodes", "edges"],
    ),
  /** inspect_node and preview_draft. */
  node: (level) => nodeSchema(level),
  preview: (level) => closed({ nodes: list(nodeSchema(level), 500) }),
  /** propose_nodes / apply results. */
  proposal: (level) =>
    closed(
      {
        ok: { type: "boolean" },
        nodes: list(IDENT, 500),
        edges: list(IDENT, 2000),
        problems: list(
          closed({
            node: { type: ["string", "null"] },
            param: { type: ["string", "null"] },
            error: errorSchema(level),
          }),
          100,
        ),
      },
      ["ok", "nodes", "edges", "problems"],
    ),
  /** ask_user: the user's own answer. */
  answer: () => closed({ answer: { type: "string", maxLength: 4000 } }),
  /** A tool that failed. */
  error: (level) => closed({ error: errorSchema(level) }),
};

export const PAYLOAD_TYPES = Object.keys(BUILDERS);

const cache = new Map();

/** The schema for one payload type at one level, with the shared definitions attached. */
export function schemaFor(type, level) {
  const key = `${type}:${level}`;
  if (!cache.has(key)) {
    const build = BUILDERS[type];
    if (!build) throw new Error(`No gate schema for payload type "${type}".`);
    const schema = build(level);
    cache.set(key, schema === transformerSchema ? schema : { ...schema, $defs: PARAM_DEFS });
  }
  return cache.get(key);
}

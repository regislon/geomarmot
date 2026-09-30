// @ts-check
/*
 * Helpers shared by several transformers. Code used by a single transformer
 * lives in that transformer's folder instead.
 */

import { qid, qlit } from "../../app/src/core/duck.js";

/** The single input port most transformers have. */
export const SINGLE_IN = Object.freeze([{ id: "input", label: "Input", description: "The rows to work on." }]);
/** The single output port most transformers have. */
export const SINGLE_OUT = Object.freeze([{ id: "output", label: "Output", description: "The rows after this step." }]);

/** Internal join key between a materialised copy of the input and JavaScript results; never leaves a node. */
export const FEATURE_ID_COLUMN = "_pv_fid";

/**
 * Move a geometry expression between coordinate systems, or leave it alone.
 *
 * always_xy is not optional: PROJ honours EPSG:4326's authority axis order,
 * latitude first, so without it every transformed point comes back swapped.
 * @param {string} expression @param {string} from @param {string} to
 */
export function toCrs(expression, from, to) {
  if (from === to) return expression;
  return `ST_Transform(${expression}, ${qlit(from)}, ${qlit(to)}, always_xy := true)`;
}

/** A comma-separated list of quoted identifiers, skipping blanks. */
export function columnList(columns) {
  return (columns || []).filter(Boolean).map(qid).join(", ");
}

/**
 * Wrap a predicate so NULL counts as "did not pass". Without this a NULL
 * predicate is neither true nor `NOT true`, and the row would vanish from both
 * ports of a filter.
 */
export function truthy(predicate) {
  return `COALESCE(${predicate}, FALSE)`;
}

/** Comparison operators, and how each builds SQL. Values are quoted and left to DuckDB to coerce. */
export const OPERATORS = {
  "=": (column, value) => `${column} = ${qlit(value)}`,
  "!=": (column, value) => `${column} <> ${qlit(value)}`,
  ">": (column, value) => `${column} > ${qlit(value)}`,
  ">=": (column, value) => `${column} >= ${qlit(value)}`,
  "<": (column, value) => `${column} < ${qlit(value)}`,
  "<=": (column, value) => `${column} <= ${qlit(value)}`,
  contains: (column, value) => `${column} LIKE ${qlit(`%${value}%`)}`,
  "starts with": (column, value) => `${column} LIKE ${qlit(`${value}%`)}`,
  "is null": (column) => `${column} IS NULL`,
  "is not null": (column) => `${column} IS NOT NULL`,
};

/** The predicate for a list of conditions joined by AND or OR, or null when none is complete. */
export function buildPredicate(conditions, logic) {
  const parts = (conditions || [])
    .filter((condition) => condition.column && condition.operator)
    .map((condition) => {
      const build = OPERATORS[condition.operator];
      return build ? `(${build(qid(condition.column), condition.value ?? "")})` : null;
    })
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.join(logic === "OR" ? " OR " : " AND ");
}

/** Ceiling on value- and rule-driven output ports, so a high-cardinality column cannot freeze the canvas. */
export const MAX_FILTER_PORTS = 40;

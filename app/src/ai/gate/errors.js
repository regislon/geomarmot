// @ts-check
/*
 * The structured error catalogue: what an error may say at levels 1 and 2.
 *
 * At those levels no error text from DuckDB or a transformer reaches the
 * provider — only `{ code, params, message }`, where the params are limited to
 * the kinds listed below (identifiers, types, CRS codes, counts, the SQL
 * construct that was refused) and the message is built from the params by the
 * template here, never copied from the original. A value from the data cannot
 * get into any of them: classify.js never captures one.
 */

/** Which params each code may carry, and the approved message. */
export const ERROR_CATALOGUE = {
  COLUMN_NOT_FOUND: { params: ["column"], message: (p) => `Column ${p.column ?? "(unknown)"} does not exist here.` },
  TYPE_MISMATCH: {
    params: ["function", "type"],
    message: (p) =>
      `A value has the wrong type${p.function ? ` for ${p.function}()` : ""}${p.type ? ` (${p.type})` : ""}.`,
  },
  CONVERSION_FAILED: {
    params: ["type"],
    message: (p) => `Some values could not be converted${p.type ? ` to ${p.type}` : ""}.`,
  },
  SQL_SYNTAX: { params: [], message: () => "The SQL does not parse." },
  SQL_FORBIDDEN_CONSTRUCT: {
    params: ["construct", "rule"],
    message: (p) => `The SQL uses something this node may not use${p.construct ? `: ${p.construct}` : ""}.`,
  },
  FUNCTION_NOT_FOUND: {
    params: ["function"],
    message: (p) => `There is no function called ${p.function ?? "(unknown)"}.`,
  },
  RELATION_NOT_FOUND: { params: [], message: () => "The SQL reads a table that does not exist." },
  CRS_UNKNOWN: { params: ["crs"], message: (p) => `The coordinate system ${p.crs ?? "(unknown)"} is not known.` },
  CRS_MISMATCH: { params: [], message: () => "The inputs are in different coordinate systems." },
  NEEDS_LONLAT: {
    params: ["crs"],
    message: (p) => `The input must be in longitude/latitude, not ${p.crs ?? "this CRS"}.`,
  },
  PORT_NOT_CONNECTED: {
    params: ["port"],
    message: (p) => `Input ${p.port ?? ""} is not connected.`.replace("  ", " "),
  },
  UPSTREAM_ERROR: { params: ["node"], message: (p) => `Blocked by an error upstream${p.node ? ` in ${p.node}` : ""}.` },
  GRAPH_LOOP: { params: [], message: () => "The graph contains a loop." },
  TIMEOUT: {
    params: ["count"],
    message: (p) => `The query took longer than ${p.count ?? "the allowed"} s and was stopped.`,
  },
  LIMIT_EXCEEDED: { params: ["count"], message: (p) => `A limit was exceeded${p.count ? ` (${p.count})` : ""}.` },
  OUT_OF_MEMORY: { params: [], message: () => "The engine ran out of memory." },
  UNKNOWN_TRANSFORMER: { params: ["transformer"], message: (p) => `There is no transformer called ${p.transformer}.` },
  NOT_AI_USABLE: { params: ["transformer"], message: (p) => `${p.transformer} cannot be used by the assistant.` },
  INVALID_PARAMS: {
    params: ["param", "transformer", "problem"],
    message: (p) =>
      `Param ${p.param ?? ""} of ${p.transformer ?? "this node"} is not valid${p.problem ? `: ${p.problem}` : ""}.`,
  },
  INVALID_INPUT: {
    params: ["param", "problem"],
    message: (p) =>
      `The tool input is not valid${p.param ? ` at ${p.param}` : ""}${p.problem ? `: ${p.problem}` : ""}.`,
  },
  UNKNOWN_NODE: { params: ["node"], message: (p) => `There is no node ${p.node}.` },
  UNKNOWN_PORT: { params: ["node", "port"], message: (p) => `Node ${p.node} has no port ${p.port}.` },
  LEVEL_TOO_LOW: { params: ["count"], message: (p) => `That needs data level ${p.count} or higher.` },
  UNKNOWN_ERROR: { params: [], message: () => "Something went wrong; the details stay in the browser at this level." },
};

export const ERROR_CODES = Object.keys(ERROR_CATALOGUE);
export const ERROR_PARAM_NAMES = [...new Set(Object.values(ERROR_CATALOGUE).flatMap((entry) => entry.params))];

const IDENT = /^[\p{L}\p{N}_ .:\-/()]{1,100}$/u;
/** What a schema check said was wrong: paths and allowed values from our own schemas, never a value sent. */
const PROBLEM = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]{1,300}$/u;

/** The `problem` param for a list of schema errors (core/jsonschema.js): the first few, as text. */
export function schemaProblem(errors) {
  return errors
    .slice(0, 3)
    .map((e) => `${e.path.replace(/^\$\.?/, "") || "value"} ${e.message}`)
    .join("; ")
    .slice(0, 300);
}

/**
 * A structured error: keeps only the params the code allows, each checked to
 * be an identifier-like string or a count, and builds the message from them.
 * @param {string} code
 * @param {Record<string, any>} [params]
 */
export function structured(code, params = {}) {
  const entry = ERROR_CATALOGUE[code] || ERROR_CATALOGUE.UNKNOWN_ERROR;
  const kept = {};
  for (const name of entry.params) {
    const value = params[name];
    if (name === "count" && Number.isFinite(value)) kept[name] = value;
    else if (name === "problem" && typeof value === "string" && PROBLEM.test(value)) kept[name] = value;
    else if (typeof value === "string" && IDENT.test(value)) kept[name] = value;
  }
  const finalCode = ERROR_CATALOGUE[code] ? code : "UNKNOWN_ERROR";
  return { code: finalCode, params: kept, message: entry.message(kept) };
}

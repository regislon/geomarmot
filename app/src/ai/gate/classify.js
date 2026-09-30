// @ts-check
/*
 * Sort an error into the structured catalogue (errors.js).
 *
 * The input is whatever went wrong — a DuckDB error, a compile state, a guard
 * verdict — and the output is `{ code, params, message }`. Only names and
 * types are ever taken out of the text: DuckDB quotes the offending *value* in
 * conversion errors ("Could not convert string 'Zürich' to INT32"), and that
 * part is never captured. Anything not recognised is UNKNOWN_ERROR with no
 * params, rather than a guess.
 */

import { structured } from "./errors.js";

/** @typedef {{ message?: string, code?: string|null, status?: string, origin?: string }} ErrorLike */

const GUARD_CONSTRUCT = [
  [/Table functions such as ([\w.]+)\(\)/, "TABLE_FUNCTION"],
  [/^"([^"]{1,100})" is not one of this node's inputs/, "FOREIGN_RELATION"],
  [/^([\w.]+)\(\) is not allowed here/, "FUNCTION_NOT_ALLOWED"],
  [/^([\w.]+)\(\) is not a function this engine has/, "UNKNOWN_FUNCTION"],
  [/A CTE may not be named "([^"]{1,100})"/, "CTE_SHADOWS_INPUT"],
  [/^One statement only/, "MULTIPLE_STATEMENTS"],
  [/^(\w+) is not a query/, "NOT_A_QUERY"],
];

/**
 * @param {ErrorLike|Error|string} error
 * @returns {{ code: string, params: Record<string, any>, message: string }}
 */
export function classify(error) {
  const e = typeof error === "string" ? { message: error } : error || {};
  const text = String(e.message || "");

  if (e.status === "blocked") return structured("UPSTREAM_ERROR", { node: e.origin });
  const blocked = String(e.message || "").match(/^Blocked: upstream error in ([\w-]{1,40})\./);
  if (blocked) return structured("UPSTREAM_ERROR", { node: blocked[1] });
  if (e.code === "SQL_SYNTAX") return structured("SQL_SYNTAX");
  if (e.code === "SQL_FORBIDDEN_CONSTRUCT") {
    for (const [pattern, rule] of GUARD_CONSTRUCT) {
      const match = text.match(pattern);
      if (match) return structured("SQL_FORBIDDEN_CONSTRUCT", { construct: match[1], rule });
    }
    return structured("SQL_FORBIDDEN_CONSTRUCT");
  }

  let m;
  if ((m = text.match(/Referenced column "([^"]{1,100})" not found/)))
    return structured("COLUMN_NOT_FOUND", { column: m[1] });
  if ((m = text.match(/column "([^"]{1,100})" (?:does not exist|not found)/i)))
    return structured("COLUMN_NOT_FOUND", { column: m[1] });
  // "Could not convert string '<value>' to <TYPE>": the value is data, only the type is kept.
  if ((m = text.match(/Conversion Error:[\s\S]*?\bto ([A-Z][A-Z0-9_]{1,30})\b/)))
    return structured("CONVERSION_FAILED", { type: m[1] });
  if (/Conversion Error/.test(text)) return structured("CONVERSION_FAILED");
  if ((m = text.match(/No function matches the given name and argument types '([\w.]+)\(/)))
    return structured("TYPE_MISMATCH", { function: m[1] });
  if ((m = text.match(/Cannot compare values of type ([A-Z][A-Z0-9_]{1,30})/)))
    return structured("TYPE_MISMATCH", { type: m[1] });
  if ((m = text.match(/(?:Scalar|Aggregate|Table) Function with name ([\w.]+) does not exist/)))
    return structured("FUNCTION_NOT_FOUND", { function: m[1] });
  if (/Table with name .{1,200} does not exist/.test(text)) return structured("RELATION_NOT_FOUND");
  if (/Parser Error|syntax error at or near/i.test(text)) return structured("SQL_SYNTAX");
  if ((m = text.match(/took longer than (\d+) s/))) return structured("TIMEOUT", { count: Number(m[1]) });
  if (/Out of Memory|memory limit/i.test(text)) return structured("OUT_OF_MEMORY");
  if ((m = text.match(/^"([^"]{1,100})" is not connected/))) return structured("PORT_NOT_CONNECTED", { port: m[1] });
  if (/inputs are in different coordinate systems/.test(text)) return structured("CRS_MISMATCH");
  if ((m = text.match(/works in longitude\/latitude, but its input is in ([A-Z]+:\d+)/)))
    return structured("NEEDS_LONLAT", { crs: m[1] });
  if ((m = text.match(/^PROJ does not know "((?:EPSG|ESRI|IGNF|OGC):\w{1,20})"/)))
    return structured("CRS_UNKNOWN", { crs: m[1] });
  if (
    (m = text.match(/\b((?:EPSG|ESRI|IGNF|OGC):\w{1,20})\b[^.]*\b(?:not known|unknown|not recognised|not recognized)/i))
  )
    return structured("CRS_UNKNOWN", { crs: m[1] });
  if (/graph contains a loop/.test(text)) return structured("GRAPH_LOOP");
  return structured("UNKNOWN_ERROR");
}

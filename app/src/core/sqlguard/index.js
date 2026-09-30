// @ts-check
/*
 * The SQL guard (docs/security.md): the one check every untrusted SQL fragment
 * goes through before DuckDB sees it.
 *
 * "Untrusted" means SQL a person or the assistant wrote into a parameter, and
 * Mode B templates. SQL that reviewed transformer code builds around those
 * fragments is trusted and never passed here.
 *
 * The guard's only contact with the engine is parsing: the placeholder form is
 * passed to json_serialize_sql() as a quoted literal, on its own connection.
 * Parsing does not execute anything.
 */

import { newConnection, qlit } from "../duck.js";
import { CONTEXTS } from "./contexts.js";
import { check } from "./rules.js";

export { CONTEXTS, INPUT_PLACEHOLDER, spliceExpression, spliceQuery } from "./contexts.js";
export { collect } from "./rules.js";

let parserConnection = null;
let knownFunctions = null;
const cache = new Map();

async function parser() {
  if (!parserConnection) parserConnection = await newConnection();
  return parserConnection;
}

async function functionCatalogue(conn) {
  if (!knownFunctions) {
    const result = await conn.query(
      "SELECT DISTINCT lower(function_name) AS name FROM duckdb_functions() " +
        "WHERE function_type NOT IN ('table', 'table_macro', 'pragma')",
    );
    knownFunctions = new Set(result.toArray().map((row) => row.toJSON().name));
  }
  return knownFunctions;
}

/** First word of a statement, for "X is not a query" messages. */
function leadingVerb(sql) {
  return (
    String(sql)
      .replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "")
      .trim()
      .split(/\s+/)[0] || ""
  ).toUpperCase();
}

/**
 * Validate one fragment in a context.
 * @param {string} fragment
 * @param {string} contextName  "query" | "expression" | "template"
 * @param {{ relations?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, problems?: any[] }>}
 */
export async function validate(fragment, contextName, opts = {}) {
  const context = CONTEXTS[contextName];
  if (!context) throw new Error(`Unknown SQL context "${contextName}".`);
  const statement = context.placeholder(String(fragment).trim().replace(/;\s*$/, ""), opts);
  const key = `${contextName}\u0000${JSON.stringify(opts.relations || [])}\u0000${statement}`;
  if (cache.has(key)) return cache.get(key);
  if (contextName === "query") {
    const verb = leadingVerb(fragment);
    if (!["SELECT", "WITH", "FROM", "VALUES", "TABLE"].includes(verb) && !verb.startsWith("(")) {
      const verdict = {
        ok: false,
        code: "SQL_FORBIDDEN_CONSTRUCT",
        message: `${verb || "That"} is not a query. This node needs a SELECT that returns rows.`,
      };
      cache.set(key, verdict);
      return verdict;
    }
  }
  const conn = await parser();
  const known = await functionCatalogue(conn);
  const result = await conn.query(`SELECT json_serialize_sql(${qlit(statement)}) AS tree`);
  const parsed = JSON.parse(result.toArray()[0].toJSON().tree);
  let verdict;
  if (parsed.error) {
    const notSelect = /Only SELECT statements/i.test(parsed.error_message || "");
    const verb = leadingVerb(fragment);
    verdict = notSelect
      ? {
          ok: false,
          code: "SQL_FORBIDDEN_CONSTRUCT",
          message: `${verb || "That"} is not a query. This node needs a SELECT that returns rows.`,
        }
      : { ok: false, code: "SQL_SYNTAX", message: String(parsed.error_message || "The SQL does not parse.") };
  } else {
    const problems = check(parsed, context.relations(opts), known);
    verdict = problems.length
      ? {
          ok: false,
          code: problems[0].code === "MULTIPLE_STATEMENTS" ? "SQL_FORBIDDEN_CONSTRUCT" : "SQL_FORBIDDEN_CONSTRUCT",
          message: problems[0].message,
          problems,
        }
      : { ok: true };
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, verdict);
  return verdict;
}

/**
 * Every untrusted fragment in a node's params, with the context it belongs to.
 * @param {{ params: Array<{ id: string, kind: string }> }} transformer
 * @param {Record<string, any>} params
 * @returns {Array<{ path: string, context: string, sql: string }>}
 */
export function fragmentsOf(transformer, params) {
  const out = [];
  const spec = (path, value) => {
    if (value && value.kind === "SQL" && typeof value.sql === "string" && value.sql.trim()) {
      out.push({ path, context: "expression", sql: value.sql });
    }
  };
  for (const p of transformer.params || []) {
    const value = params?.[p.id];
    if (value === undefined || value === null) continue;
    switch (p.kind) {
      case "sqltext":
      case "sqlcreate":
        if (typeof value === "string" && value.trim())
          out.push({ path: `params.${p.id}`, context: "query", sql: value });
        break;
      case "valuespec":
        spec(`params.${p.id}`, value);
        break;
      case "creates":
      case "valuerows":
        (value || []).forEach((row, i) => spec(`params.${p.id}[${i}].value`, row?.value));
        break;
      case "actions":
        (value || []).forEach((row, i) => {
          spec(`params.${p.id}[${i}].spec`, row?.spec);
          if (typeof row?.value === "string" && row.value.trim()) {
            out.push({ path: `params.${p.id}[${i}].value`, context: "expression", sql: row.value });
          }
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Validate every untrusted fragment of a restricted node. Returns the first
 * refusal, or null when all pass.
 */
export async function guardNode(transformer, node) {
  if ((node.sqlMode || "restricted") === "unrestricted") return null;
  for (const fragment of fragmentsOf(transformer, node.params)) {
    const verdict = await validate(fragment.sql, fragment.context);
    if (!verdict.ok) return { ...verdict, path: fragment.path };
  }
  return null;
}

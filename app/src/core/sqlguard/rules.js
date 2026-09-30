// @ts-check
/*
 * The rules the SQL guard applies to a parsed statement.
 *
 * Input is the tree `json_serialize_sql()` produces (only SELECT statements
 * serialise; anything else comes back as an error). The walk collects every
 * base table, table function, CTE and function name, then checks them against
 * the context's allowed relations and the engine's function catalogue.
 */

/** Functions that read settings, the environment or files, refused even though they are scalar. */
export const FUNCTION_DENYLIST = new Set([
  "getenv",
  "current_setting",
  "getvariable",
  "current_database",
  "current_schema",
  "current_schemas",
  "read_text",
  "read_blob",
  "glob",
  "sniff_csv",
  "st_read",
  "st_read_meta",
]);

/**
 * Collect what a parsed statement touches.
 * @param {any} tree
 */
export function collect(tree) {
  const found = { tables: [], tableFunctions: [], functions: [], ctes: new Set() };
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.type === "BASE_TABLE" && typeof node.table_name === "string") {
      found.tables.push({ schema: node.schema_name || "", catalog: node.catalog_name || "", name: node.table_name });
    }
    if (node.type === "TABLE_FUNCTION") found.tableFunctions.push(node.function?.function_name || "?");
    if (node.class === "FUNCTION" && typeof node.function_name === "string" && node.type !== "TABLE_FUNCTION") {
      found.functions.push({
        name: node.function_name.toLowerCase(),
        schema: node.schema || "",
        isOperator: Boolean(node.is_operator),
      });
    }
    if (node.cte_map?.map) for (const entry of node.cte_map.map) found.ctes.add(String(entry.key).toLowerCase());
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  visit(tree);
  return found;
}

/**
 * Check a parsed statement. Returns a list of problems (empty when it passes).
 * @param {any} parsed         the JSON from json_serialize_sql
 * @param {Set<string>} allowed  relation names the statement may read
 * @param {Set<string>} known    scalar/aggregate/macro function names the engine has
 */
export function check(parsed, allowed, known) {
  const problems = [];
  const statements = parsed.statements || [];
  if (statements.length !== 1) {
    problems.push({
      code: "MULTIPLE_STATEMENTS",
      message: "One statement only — everything after the first ; would be ignored.",
    });
    return problems;
  }
  const found = collect(statements[0]);
  const lowerAllowed = new Set([...allowed].map((name) => name.toLowerCase()));
  for (const cte of found.ctes) {
    if (lowerAllowed.has(cte) && cte !== "input") {
      problems.push({
        code: "CTE_SHADOWS_INPUT",
        message: `A CTE may not be named "${cte}", which is one of the inputs.`,
      });
    }
  }
  for (const name of found.tableFunctions) {
    problems.push({
      code: "TABLE_FUNCTION",
      message: `Table functions such as ${name}() are not allowed here: this SQL may only read its inputs.`,
    });
  }
  for (const table of found.tables) {
    const name = table.name.toLowerCase();
    if (table.schema || table.catalog || /[./\\:]/.test(table.name)) {
      problems.push({ code: "FOREIGN_RELATION", message: `"${table.name}" is not one of this node's inputs.` });
    } else if (!lowerAllowed.has(name) && !found.ctes.has(name)) {
      problems.push({
        code: "FOREIGN_RELATION",
        message: `"${table.name}" is not one of this node's inputs; read from input.`,
      });
    }
  }
  for (const fn of found.functions) {
    if (fn.isOperator) continue;
    if (FUNCTION_DENYLIST.has(fn.name)) {
      problems.push({ code: "FUNCTION_NOT_ALLOWED", message: `${fn.name}() is not allowed here.` });
    } else if (fn.schema && fn.schema !== "main") {
      problems.push({ code: "FUNCTION_NOT_ALLOWED", message: `${fn.schema}.${fn.name}() is not allowed here.` });
    } else if (known && !known.has(fn.name)) {
      problems.push({ code: "UNKNOWN_FUNCTION", message: `${fn.name}() is not a function this engine has.` });
    }
  }
  return problems;
}

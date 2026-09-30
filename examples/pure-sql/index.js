// @ts-check
// Pattern 1 — pure SQL: a lazy view, costs nothing until read. Prefer this whenever DuckDB can do the work.
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../../transformers/_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "ExampleNonEmpty",
  group: "Filters",
  summary: "Example: splits rows into those where an attribute has a value and those where it is empty.",
  description:
    "A reference transformer for the pure SQL pattern. It sends rows whose chosen attribute is not NULL " +
    "and not an empty string to one port, and every other row to a second port, so the two outputs " +
    "always add up to the input. All the work is two SELECT statements; the compiler turns each into a " +
    "view. It exists to be read, not used: the Tester does this and more.",
  whenToUse: ["read this before writing a filter-shaped transformer", "see how two output ports are declared"],
  whenNotToUse: ["real graphs — use Tester"],
  keywords: ["example", "reference", "pure sql"],
  examples: [{ input: "names a, '', NULL", params: "Attribute = name", output: "filled: a; empty: '' and NULL" }],
  inputs: SINGLE_IN,
  outputs: [
    { id: "filled", label: "Filled", description: "Rows where the attribute has a non-empty value." },
    { id: "empty", label: "Empty", description: "Rows where it is NULL or an empty string." },
  ],
  params: [
    param.column("column", "Attribute", {
      description: "The attribute whose emptiness decides which port a row goes to.",
    }),
  ],
  sql: (ctx) => {
    const test = `coalesce(CAST(${qid(ctx.params.column)} AS VARCHAR), '') <> ''`;
    return {
      filled: `SELECT * FROM ${ctx.inputs.input} WHERE ${test}`,
      empty: `SELECT * FROM ${ctx.inputs.input} WHERE NOT (${test})`,
    };
  },
});

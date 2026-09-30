// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, spliceQuery } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "SQLTransformer",
  group: "Reshape",
  summary: "Any DuckDB SELECT over the incoming rows, which the query reads as `input`.",
  description:
    "SQLTransformer runs one DuckDB SELECT with the incoming rows bound to the table name input, and its " +
    "result is the output — any shape, any columns, any number of rows. It is the escape hatch for anything " +
    "the other transformers do not cover: joins with a spatial predicate, window functions, pivots. Your own " +
    "CTEs are merged with the binding for input rather than nested, so a query that opens with WITH works " +
    "as written. SQL here is restricted to reading input unless you allow unrestricted SQL in the inspector. " +
    "An empty query passes rows through. It has one input; combine streams first with FeatureJoiner or Unioner.",
  whenToUse: [
    "count rows per category in one line",
    "a window function such as a running total",
    "a query an assistant wrote against this node's schema",
  ],
  whenNotToUse: [
    "only adding columns — AttributeCreator checks that the query really adds one",
    "a simple filter — Tester shows its two outputs",
  ],
  keywords: ["sql", "query", "select", "custom", "duckdb", "expression", "escape hatch"],
  examples: [
    {
      input: "people with cat",
      params: "SELECT cat, count(*) AS n FROM input GROUP BY cat",
      output: "one row per category with its count",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "Whatever the query returns." }],
  params: [
    param.sqltext("sql", "Query", {
      default: "SELECT * FROM input",
      placeholder: "SELECT * FROM input",
      description: "A single DuckDB SELECT that reads the incoming rows as the table input.",
    }),
  ],
  sql: (ctx) => {
    const statement = (ctx.params.sql || "").trim();
    if (!statement) return { output: `SELECT * FROM ${ctx.inputs.input}` };
    return { output: spliceQuery(statement, ctx.inputs.input) };
  },
});

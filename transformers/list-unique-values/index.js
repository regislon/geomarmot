// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Analysis",
  id: "ListUniqueValues",
  summary: "One row per distinct value of an attribute, with its count and share of all rows.",
  description:
    "ListUniqueValues reports what an attribute holds: one output row per distinct value, with n, how " +
    "many rows have it, and percent, its share of all rows rounded to two decimals, most frequent first " +
    "and ties in value order. NULL counts as a value of its own. The result is a table, so it can be " +
    "sorted, filtered and exported like any other stream — the quickest way to see the categories of a " +
    "column before writing a filter. It replaces the input rows rather than annotating them.",
  whenToUse: [
    "see the categories of a column before filtering",
    "count how many rows each value has",
    "check a column for unexpected values",
  ],
  whenNotToUse: [
    "numeric distributions — use AttributeHistogram",
    "counts per group with other aggregates — use Aggregator",
  ],
  keywords: ["unique values", "distinct", "frequency", "value counts", "categories", "histogram of values"],
  examples: [
    {
      input: "cat values a, b, a, NULL, c",
      params: "Attribute = cat",
      output: "a 2 40%, then b, c and NULL with 1 each",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "One row per value: value, n and percent." }],
  params: [
    param.column("column", "Attribute", { description: "The attribute whose distinct values are listed and counted." }),
  ],
  sql: (ctx) => {
    if (!ctx.params.column) throw new Error("Choose an attribute to list.");
    const column = qid(ctx.params.column);
    return {
      output:
        `SELECT ${column} AS value, count(*) AS n, round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS percent ` +
        `FROM ${ctx.inputs.input} GROUP BY ${column} ORDER BY n DESC, 1`,
    };
  },
});

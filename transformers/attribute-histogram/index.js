// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Analysis",
  id: "AttributeHistogram",
  summary: "Bins an attribute's values into equal-width bins and counts each bin.",
  description:
    "AttributeHistogram divides the range of a numeric attribute, from its minimum to its maximum, into " +
    "the number of equal-width bins you choose, and returns one row per non-empty bin: bin (from 0), " +
    "bin_start, bin_end and n. The maximum value is pulled into the top bin rather than getting a bin of " +
    "its own, so the counts add up to the number of rows with a value; NULLs are left out. When every " +
    "value is the same, all of them fall into one bin. Empty bins do not appear. The result replaces the " +
    "input rows, as a table you can export or chart elsewhere.",
  whenToUse: [
    "see how plot areas are distributed",
    "choose thresholds for a classification",
    "check a measurement for outliers",
  ],
  whenNotToUse: ["counts of category values — use ListUniqueValues", "quantiles and spread — use StatisticsCalculator"],
  keywords: ["histogram", "bins", "distribution", "frequency", "classes", "buckets"],
  examples: [
    {
      input: "v = 0, 1, 2, 3, 4, 8, NULL",
      params: "Bins 4",
      output: "bins of width 2: bin 0 holds 2 values, bin 1 holds 2, bin 2 holds 1, bin 3 holds the 8",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "One row per non-empty bin: bin, bin_start, bin_end, n." }],
  params: [
    param.column("column", "Attribute", { description: "The numeric attribute whose values are binned and counted." }),
    param.string("bins", "Bins", {
      default: "20",
      description: "How many equal-width bins the range from minimum to maximum is divided into.",
    }),
  ],
  sql: (ctx) => {
    if (!ctx.params.column) throw new Error("Choose an attribute to bin.");
    const column = qid(ctx.params.column);
    const bins = Math.max(1, Math.round(Number(ctx.params.bins ?? 20)));
    if (!Number.isFinite(bins)) throw new Error("Bins must be a number.");
    return {
      output:
        `WITH b AS (SELECT ${column} AS v, min(${column}) OVER () AS lo, max(${column}) OVER () AS hi ` +
        `FROM ${ctx.inputs.input} WHERE ${column} IS NOT NULL), ` +
        `w AS (SELECT *, (hi - lo) / ${bins} AS width FROM b) ` +
        `SELECT bin, min(lo + bin * width) AS bin_start, min(lo + (bin + 1) * width) AS bin_end, count(*) AS n FROM (` +
        `SELECT *, least(${bins - 1}, floor(CASE WHEN width = 0 THEN 0 ELSE (v - lo) / width END))::INT AS bin FROM w` +
        `) GROUP BY bin ORDER BY bin`,
    };
  },
});

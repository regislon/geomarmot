// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid, qlit } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Analysis",
  id: "AttributeCorrelation",
  summary: "Pearson correlation between every pair of the chosen numeric attributes, strongest first.",
  description:
    "AttributeCorrelation computes the Pearson correlation coefficient r for every unordered pair of the " +
    "numeric attributes you choose, over all input rows, and returns one row per pair: attribute_a, " +
    "attribute_b, r and n, the number of rows. Pairs come strongest first by the absolute value of r, with " +
    "undefined correlations last. One row per pair, rather than a matrix, says everything once and can be " +
    "sorted, filtered and exported. It measures linear association only, and at least two attributes are " +
    "needed. The input rows are replaced by the pairs.",
  whenToUse: [
    "find which numeric attributes move together",
    "check two measurements for redundancy before modelling",
    "a quick correlation table for a report",
  ],
  whenNotToUse: [
    "the distribution of one attribute — use AttributeHistogram",
    "summary statistics — use StatisticsCalculator",
  ],
  keywords: ["correlation", "pearson", "relationship", "association", "r", "covariance"],
  examples: [
    {
      input: "a = 1, 2, 3, 4 and b = 2a",
      params: "Attributes = a, b, c",
      output: "(a, b) with r = 1 first, then the pairs with c",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "output", label: "Output", description: "One row per pair of attributes: attribute_a, attribute_b, r, n." },
  ],
  params: [
    param.columns("columns", "Attributes", {
      filter: "numeric",
      description: "The numeric attributes to correlate pairwise; at least two are needed.",
    }),
  ],
  sql: (ctx) => {
    const columns = (ctx.params.columns || []).filter(Boolean);
    if (columns.length < 2) throw new Error("Choose at least two numeric attributes.");
    const pairs = [];
    for (let i = 0; i < columns.length; i++) {
      for (let j = i + 1; j < columns.length; j++) {
        pairs.push(
          `SELECT ${qlit(columns[i])} AS attribute_a, ${qlit(columns[j])} AS attribute_b, ` +
            `corr(${qid(columns[i])}, ${qid(columns[j])}) AS r, count(*) AS n FROM ${ctx.inputs.input}`,
        );
      }
    }
    return { output: `SELECT * FROM (${pairs.join(" UNION ALL ")}) ORDER BY abs(r) DESC NULLS LAST` };
  },
});

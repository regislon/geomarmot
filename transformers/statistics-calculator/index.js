// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

/*
 * Each statistic works both as an aggregate and as a window function, so one
 * table serves the Summary port and the Complete port. Range is max − min
 * because DuckDB has no range aggregate; sample and population standard
 * deviation disagree on small groups, which is when people look.
 */
const STATISTIC_SQL = {
  Minimum: (column) => `min(${column})`,
  Maximum: (column) => `max(${column})`,
  Sum: (column) => `sum(${column})`,
  Mean: (column) => `avg(${column})`,
  Median: (column) => `median(${column})`,
  Range: (column) => `max(${column}) - min(${column})`,
  "Standard deviation": (column) => `stddev_samp(${column})`,
  "Standard deviation (population)": (column) => `stddev_pop(${column})`,
  Mode: (column) => `mode(${column})`,
  "Total count": () => "count(*)",
  "Numeric count": (column) => `count(${column})`,
  "Value count": (column) => `count(DISTINCT ${column})`,
};

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "StatisticsCalculator",
  group: "Reshape",
  summary: "Statistics of numeric attributes per group, as a summary or attached to every row.",
  description:
    "StatisticsCalculator computes, for each numeric attribute you choose and each group of rows sharing " +
    "the Group by values, the statistics you tick: minimum, maximum, sum, mean, median, range, sample and " +
    "population standard deviation, mode, and three counts (every row, rows with a value, distinct values). " +
    "Summary has one row per group. Complete is every input row with its group's statistics attached, " +
    "computed as a window rather than a join. Results are named attribute_statistic, such as v_mean. The " +
    "attribute picker only offers numeric columns, since sum over text would fail when read. Without " +
    "attributes it counts rows.",
  whenToUse: [
    "mean and spread of plot areas per region",
    "attach each group's total to every row to compute shares",
    "a one-row summary of a numeric column",
  ],
  whenNotToUse: [
    "counts and sums with your own names, or a dissolved shape per group — use Aggregator",
    "the distribution of values in bins — use AttributeHistogram",
  ],
  keywords: ["statistics", "mean", "median", "standard deviation", "summary", "group", "sum", "range", "window"],
  examples: [
    {
      input: "people with cat and v",
      params: "Group by cat; v: Sum, Mean",
      output: "Summary: cat, v_sum, v_mean per category; Complete: every row plus v_sum, v_mean",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "summary", label: "Summary", description: "One row per group with its statistics." },
    { id: "complete", label: "Complete", description: "Every input row with its group's statistics attached." },
  ],
  params: [
    param.columns("groupBy", "Group by", {
      description: "The attributes whose values define a group; leave empty for statistics over the whole input.",
    }),
    param.columns("attributes", "Attributes", {
      filter: "numeric",
      description: "The numeric attributes to compute statistics of; only numeric columns are offered.",
    }),
    param.choices("stats", "Statistics", {
      choices: Object.keys(STATISTIC_SQL),
      default: ["Sum", "Mean", "Minimum", "Maximum", "Standard deviation"],
      description: "Which statistics to compute for every chosen attribute, each becoming its own column.",
    }),
  ],
  sql: (ctx) => {
    const groups = (ctx.params.groupBy || []).filter(Boolean).map(qid);
    const attributes = (ctx.params.attributes || []).filter(Boolean);
    const stats = (ctx.params.stats || []).filter((name) => STATISTIC_SQL[name]);
    const terms = [];
    for (const attribute of attributes) {
      for (const name of stats) {
        terms.push({
          sql: STATISTIC_SQL[name](qid(attribute)),
          alias: `${attribute}_${name.toLowerCase().replace(/\s+/g, "_")}`,
        });
      }
    }
    if (!terms.length) terms.push({ sql: "count(*)", alias: "count" });
    const input = ctx.inputs.input;
    const groupClause = groups.length ? ` GROUP BY ${groups.join(", ")}` : "";
    const over = groups.length ? `OVER (PARTITION BY ${groups.join(", ")})` : "OVER ()";
    return {
      summary: `SELECT ${[...groups, ...terms.map((t) => `${t.sql} AS ${qid(t.alias)}`)].join(", ")} FROM ${input}${groupClause}`,
      complete: `SELECT *, ${terms.map((t) => `${t.sql} ${over} AS ${qid(t.alias)}`).join(", ")} FROM ${input}`,
    };
  },
});

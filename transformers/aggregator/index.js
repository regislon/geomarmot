// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

/** The aggregate functions the inspector offers. */
export const AGGREGATE_FUNCTIONS = ["count", "sum", "min", "max", "mean", "median", "count distinct"];

const AGGREGATE_SQL = {
  count: (column) => (column ? `count(${column})` : "count(*)"),
  sum: (column) => `sum(${column})`,
  min: (column) => `min(${column})`,
  max: (column) => `max(${column})`,
  mean: (column) => `avg(${column})`,
  median: (column) => `median(${column})`,
  "count distinct": (column) => `count(DISTINCT ${column})`,
};

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Aggregator",
  group: "Reshape",
  summary: "Groups rows and computes aggregates per group, optionally dissolving their geometry.",
  description:
    "Aggregator turns each group of rows — rows sharing the values of the Group by attributes — into one " +
    "row carrying those values and the aggregates you ask for: count, sum, min, max, mean, median and count " +
    "distinct, each over an attribute and under a name you can choose. By default the geometry is dropped, " +
    "the cheap and common case; set Geometry to Dissolve to merge each group's shapes into one with " +
    "ST_Union_Agg, which joins touching polygons into a single ring rather than collecting them. With no " +
    "aggregates it counts the rows per group. Without Group by, the whole input is one group.",
  whenToUse: [
    "count plots per category",
    "sum the area of each farm's fields",
    "one dissolved shape per region with its total population",
  ],
  whenNotToUse: [
    "statistics attached back to every row — use StatisticsCalculator's Complete port",
    "merging shapes when the shape is the point — Dissolver says so more plainly",
  ],
  keywords: ["group by", "aggregate", "summarise", "sum", "count", "average", "dissolve", "total"],
  examples: [
    {
      input: "people with cat and v",
      params: "Group by cat; sum of v, mean of v",
      output: "one row per cat with sum_v and avg_v",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "One row per group: the group values, the aggregates and, with Dissolve, the merged geometry.",
    },
  ],
  params: [
    param.columns("groupBy", "Group by", {
      description: "The attributes whose values define a group; leave empty to aggregate the whole input.",
    }),
    param.aggregates("aggregates", "Aggregates", {
      description: "Each aggregate is a function, the attribute it runs over and an optional name for the result.",
    }),
    param.select("geometry", "Geometry", {
      options: [
        { value: "Drop", description: "The output has no geometry." },
        { value: "Dissolve", description: "Merge each group's geometries into one shape with ST_Union_Agg." },
      ],
      default: "Drop",
      description: "What happens to the geometry of the rows in each group: dropped, or merged into one shape.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const groups = (ctx.params.groupBy || []).filter(Boolean).map(qid);
    const aggregates = (ctx.params.aggregates || [])
      .filter((aggregate) => aggregate.func && AGGREGATE_SQL[aggregate.func])
      .map((aggregate) => {
        const alias = aggregate.alias || `${aggregate.func.replace(/\s+/g, "_")}_${aggregate.column || "all"}`;
        return `${AGGREGATE_SQL[aggregate.func](aggregate.column ? qid(aggregate.column) : null)} AS ${qid(alias)}`;
      });
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    const dissolve =
      (ctx.params.geometry ?? "Drop") === "Dissolve" && geometry
        ? [`ST_Union_Agg(${geometryExpression(geometry)}) AS ${qid(geometry.name)}`]
        : [];
    if (!aggregates.length && !dissolve.length) aggregates.push('count(*) AS "count"');
    const selection = [...groups, ...aggregates, ...dissolve].join(", ");
    return {
      output: `SELECT ${selection} FROM ${ctx.inputs.input}${groups.length ? ` GROUP BY ${groups.join(", ")}` : ""}`,
    };
  },
});

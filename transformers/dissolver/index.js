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

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Dissolver",
  group: "Reshape",
  summary: "Merges the geometry of every row in a group into one shape, counting the parts.",
  description:
    "Dissolver groups rows by the attributes you choose and merges each group's geometries into a single " +
    "shape with ST_Union_Agg: shared borders between touching polygons disappear, so a set of provinces " +
    "becomes one outline rather than a collection of pieces. Each output row carries the group values, the " +
    "merged geometry and parts, the number of rows that went in. With no attributes chosen, the whole input " +
    "becomes one shape. Attributes other than the group values do not survive; add an Aggregator if you " +
    "need their totals. It needs a geometry column.",
  whenToUse: [
    "one outline per region from its districts",
    "merge overlapping buffers into one area",
    "a single shape for the whole layer",
  ],
  whenNotToUse: [
    "counts or sums per group with no need for the shape — use Aggregator",
    "keeping the overlaps as separate pieces — use AreaOnAreaOverlayer",
  ],
  keywords: ["dissolve", "merge", "union", "combine polygons", "outline", "aggregate geometry"],
  examples: [
    {
      input: "three unit squares, two of cat farm",
      params: "Dissolve by = cat",
      output: "farm: one 2×1 rectangle with parts 2; forest: one square with parts 1",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "One row per group: the group values, the merged geometry and parts.",
    },
  ],
  params: [
    param.columns("groupBy", "Dissolve by", {
      description: "The attributes whose values define the groups to merge; leave empty for one shape overall.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) {
      throw new Error(
        "This input has no geometry to dissolve. If it came from PolygonToH3, set its Geometry to Hexagons — or add an H3GeometryFromIndex before this node.",
      );
    }
    const groups = (ctx.params.groupBy || []).filter(Boolean).map(qid);
    const selection = [
      ...groups,
      `ST_Union_Agg(${geometryExpression(geometry)}) AS ${qid(geometry.name)}`,
      "count(*) AS parts",
    ].join(", ");
    return {
      output: `SELECT ${selection} FROM ${ctx.inputs.input}${groups.length ? ` GROUP BY ${groups.join(", ")}` : ""}`,
    };
  },
});

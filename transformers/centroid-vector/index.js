// @ts-check
import { defineTransformer, API_VERSION, sqlGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  sqlGeometryTool({
    apiVersion: API_VERSION,
    id: "CentroidVector",
    summary: "Replaces each feature with its centroid, which may fall outside a concave shape.",
    description:
      "CentroidVector replaces every geometry with its centroid: the centre of mass of a polygon, the " +
      "length-weighted middle of a line, the mean of a set of points. Attributes ride along unchanged. The " +
      "centroid of a concave shape — a U, a crescent, a bay — can lie outside the shape itself, which is " +
      "fine for labelling a region on a small-scale map but wrong for anything that needs a point on the " +
      "feature; RepresentativePointVector guarantees one. Null geometries stay null. It needs a geometry column.",
    whenToUse: [
      "one point per polygon for a thematic map",
      "the middle of each line",
      "points to measure distances between regions",
    ],
    whenNotToUse: ["a point guaranteed to lie on the feature — use RepresentativePointVector"],
    keywords: ["centroid", "centre", "center", "midpoint", "point", "label point"],
    examples: [{ input: "a 2×2 square at the origin", params: "none", output: "POINT (1 1)" }],
    outputDescription: "The rows with each geometry replaced by its centroid.",
    params: [],
    build: (source) => `ST_Centroid(${source})`,
  }),
);

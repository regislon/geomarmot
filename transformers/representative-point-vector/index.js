// @ts-check
import { defineTransformer, API_VERSION, sqlGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  sqlGeometryTool({
    apiVersion: API_VERSION,
    id: "RepresentativePointVector",
    summary: "Replaces each feature with a point guaranteed to lie inside it.",
    description:
      "RepresentativePointVector replaces every geometry with a point on the surface of the feature: " +
      "inside a polygon, on a line, one of a multipoint's points. Unlike a centroid, the point is always on " +
      "the feature, even for a U-shaped polygon or a crescent whose centroid falls in the gap, which makes it " +
      "the right point for joining a polygon to what lies under it or for placing a label inside its area. " +
      "It is not the centre and not the pole of inaccessibility. Attributes ride along; null geometries stay " +
      "null. It needs a geometry column.",
    whenToUse: [
      "a label point that is inside every polygon",
      "points for a point-in-polygon lookup",
      "one point per concave parcel",
    ],
    whenNotToUse: ["the geometric centre — use CentroidVector"],
    keywords: ["point on surface", "interior point", "label point", "representative point", "inside"],
    examples: [{ input: "a U-shaped polygon", params: "none", output: "a point inside one arm of the U" }],
    outputDescription: "The rows with each geometry replaced by a point on the feature.",
    params: [],
    build: (source) => `ST_PointOnSurface(${source})`,
  }),
);

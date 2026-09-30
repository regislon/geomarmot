// @ts-check
import { defineTransformer, API_VERSION, jsGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  jsGeometryTool({
    apiVersion: API_VERSION,
    id: "MinimumBoundingBox",
    summary: "The smallest rectangle around each feature, at any angle — not axis-aligned.",
    description:
      "MinimumBoundingBox replaces every geometry with the smallest-area rectangle that contains it, " +
      "rotated to whatever angle fits best, unlike an envelope whose sides follow the axes. A square tilted " +
      "by 45° comes back as itself, where its envelope would be half as large again. The work is done in " +
      "JavaScript with JSTS, because DuckDB has no such function; rows are materialised with an id so each " +
      "result joins back to its own row. Attributes ride along and null geometries stay null. It needs a " +
      "geometry column.",
    whenToUse: [
      "the orientation and size of each parcel",
      "a tight rectangle around a diagonal feature",
      "compare a shape's area with its bounding rectangle",
    ],
    whenNotToUse: ["an axis-aligned box with its bounds as attributes — use BoundingBoxReplacer"],
    keywords: ["minimum bounding rectangle", "oriented bounding box", "rotated rectangle", "mbr", "min area rectangle"],
    examples: [{ input: "a square tilted 45°", params: "none", output: "the same square" }],
    outputDescription: "The rows with each geometry replaced by its minimum-area rectangle.",
    params: [],
  }),
);

// @ts-check
import { defineTransformer, API_VERSION, jsGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  jsGeometryTool({
    apiVersion: API_VERSION,
    id: "MinimumBoundingCircle",
    summary: "The smallest circle enclosing each feature, as a polygon.",
    description:
      "MinimumBoundingCircle replaces every geometry with the smallest circle that contains all of it, drawn " +
      "as a polygon so the map and the writers can use it. The circle is computed in the stream's own " +
      "coordinates, so on longitude/latitude it is round in degrees rather than on the ground; reproject to a " +
      "local metric system first when the true shape matters. The work is done in JavaScript with JSTS. " +
      "Attributes ride along and null geometries stay null. It needs a geometry column.",
    whenToUse: [
      "the reach of a set of sites around their centre",
      "a circular zone that covers each feature",
      "compare how compact shapes are",
    ],
    whenNotToUse: ["a zone at a fixed distance around a feature — use Bufferer"],
    keywords: ["minimum bounding circle", "enclosing circle", "circumscribed circle", "circle"],
    examples: [{ input: "a 2×2 square", params: "none", output: "a circle of radius √2 around its centre" }],
    outputDescription: "The rows with each geometry replaced by its enclosing circle.",
    params: [],
  }),
);

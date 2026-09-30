// @ts-check
import { defineTransformer, API_VERSION, param, jsGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  jsGeometryTool({
    apiVersion: API_VERSION,
    id: "DensifyFeatures",
    summary: "Adds vertices so that no segment of a line or ring is longer than the tolerance.",
    description:
      "DensifyFeatures inserts evenly spaced vertices into every segment longer than the tolerance, so no " +
      "segment of a line or polygon ring is longer than it. The shape itself does not change — a densified " +
      "polygon has exactly the area it had — but it bends properly when reprojected afterwards, which matters " +
      "for long straight edges drawn across a projection. The tolerance is in the stream's own units. The " +
      "work is done in JavaScript with JSTS. Points are unchanged; a zero or negative tolerance is refused.",
    whenToUse: [
      "before reprojecting large rectangles so their edges curve correctly",
      "give long straight segments intermediate vertices",
      "prepare lines for smoothing",
    ],
    whenNotToUse: ["removing vertices — use SimplifyFeatures"],
    keywords: ["densify", "add vertices", "segmentize", "interpolate", "subdivide"],
    examples: [
      { input: "LINESTRING (0 0, 2 0)", params: "Max segment 0.5", output: "LINESTRING (0 0, 0.5 0, 1 0, 1.5 0, 2 0)" },
    ],
    outputDescription: "The rows with each geometry densified.",
    params: [
      param.string("tolerance", "Max segment (degrees)", {
        default: "0.01",
        units: "degrees",
        description: "The longest a segment may be after densifying, in the stream's own units (degrees on lon/lat).",
      }),
    ],
    options: (params) => {
      const tolerance = Number(params.tolerance ?? 0.01);
      if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("Tolerance must be above zero.");
      return { tolerance };
    },
  }),
);

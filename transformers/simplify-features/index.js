// @ts-check
import { defineTransformer, API_VERSION, param, sqlGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  sqlGeometryTool({
    apiVersion: API_VERSION,
    id: "SimplifyFeatures",
    summary: "Removes vertices within a tolerance while keeping every shape valid.",
    description:
      "SimplifyFeatures removes vertices from lines and polygons wherever the outline stays within the " +
      "tolerance of the original, with the Douglas–Peucker algorithm in its topology-preserving form: a " +
      "polygon is never turned into a self-intersecting one, so areas measured afterwards stay meaningful. " +
      "The tolerance is in the stream's own units — degrees on longitude/latitude, where 0.001 is roughly " +
      "100 m. Points are unchanged. Use it to make detailed shapes lighter to draw and export. It needs a " +
      "geometry column, and a negative tolerance is refused.",
    whenToUse: [
      "lighten detailed coastlines before drawing them",
      "reduce file size before exporting",
      "remove near-collinear vertices",
    ],
    whenNotToUse: ["adding vertices — use DensifyFeatures", "rounding corners — use SmoothVectors"],
    keywords: ["simplify", "generalise", "generalize", "douglas peucker", "reduce vertices", "lighten"],
    examples: [
      {
        input: "a line wobbling within 0.05 of a straight line",
        params: "Tolerance 0.1",
        output: "the straight line through its ends",
      },
    ],
    outputDescription: "The rows with each geometry simplified.",
    params: [
      param.string("tolerance", "Tolerance (degrees)", {
        default: "0.001",
        units: "degrees",
        description:
          "How far the simplified outline may stray from the original, in the stream's own units (degrees on lon/lat).",
      }),
    ],
    build: (source, params) => {
      const tolerance = Number(params.tolerance ?? 0.001);
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Tolerance must be a positive number.");
      return `ST_SimplifyPreserveTopology(${source}, ${tolerance})`;
    },
  }),
);

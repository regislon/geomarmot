// @ts-check
import { defineTransformer, API_VERSION, param, jsGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  jsGeometryTool({
    apiVersion: API_VERSION,
    id: "SmoothVectors",
    summary: "Rounds off corners by Chaikin subdivision; each pass doubles the vertices.",
    description:
      "SmoothVectors rounds the corners of lines and polygons with Chaikin's corner-cutting: every pass " +
      "replaces each corner by two points a quarter of the way along its segments, so the outline gets " +
      "smoother and the vertex count doubles. The shape also shrinks slightly with each pass, since corners " +
      "are cut off, and a line keeps its end points. It suits digitised outlines that look jagged. The work is " +
      "done in JavaScript with JSTS. Points are unchanged. It needs a geometry column.",
    whenToUse: [
      "soften jagged digitised boundaries",
      "round the corners of a generalised outline for display",
      "smooth a track drawn with few points",
    ],
    whenNotToUse: [
      "removing detail — use SimplifyFeatures",
      "adding vertices without changing the shape — use DensifyFeatures",
    ],
    keywords: ["smooth", "chaikin", "round corners", "soften", "curve"],
    examples: [
      { input: "LINESTRING (0 0, 2 0, 2 2)", params: "Passes 1", output: "LINESTRING (0 0, 1.5 0, 2 0.5, 2 2)" },
    ],
    outputDescription: "The rows with each geometry smoothed.",
    params: [
      param.select("iterations", "Passes", {
        options: [
          { value: "1", description: "One pass: corners cut once." },
          { value: "2", description: "Two passes (default): noticeably round." },
          { value: "3", description: "Three passes: very round, eight times the vertices." },
          { value: "4", description: "Four passes: sixteen times the vertices." },
        ],
        default: "2",
        description: "How many times to cut every corner; each pass doubles the number of vertices.",
      }),
    ],
    options: (params) => ({ iterations: Math.max(1, Math.round(Number(params.iterations ?? 2))) }),
  }),
);

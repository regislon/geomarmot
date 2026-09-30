// @ts-check
import { defineTransformer, API_VERSION, param, sqlGeometryTool } from "../_kit/index.js";

const whole = (params) => (params.scope ?? "Each feature") === "The whole layer";

export default defineTransformer(
  sqlGeometryTool({
    apiVersion: API_VERSION,
    id: "MinimumConvexHull",
    summary: "The convex hull of each feature, or one hull around the whole layer.",
    description:
      "MinimumConvexHull wraps geometry in its convex hull: the smallest convex polygon that contains it, " +
      "as if a rubber band were stretched around it. For Each feature, every geometry is replaced by its own " +
      "hull and attributes ride along. For The whole layer, every geometry is merged first and the result " +
      "is one row holding a single hull around everything, with no other attributes, since one row cannot " +
      "carry every row's values. A hull of one point is the point; of collinear points, a line. It needs a " +
      "geometry column.",
    whenToUse: [
      "an outline around a cloud of points",
      "the area spanned by a set of sites",
      "a convex version of each irregular polygon",
    ],
    whenNotToUse: [
      "an axis-aligned rectangle — use BoundingBoxReplacer",
      "a tight outline that follows concave edges — there is no concave hull here",
    ],
    keywords: ["convex hull", "hull", "outline", "envelope", "enclose", "rubber band"],
    examples: [
      {
        input: "points (0 0), (4 0), (2 3), (2 1)",
        params: "The whole layer",
        output: "one triangle through (0 0), (4 0), (2 3)",
      },
    ],
    outputDescription: "Each geometry's hull, or one row with the hull of everything.",
    params: [
      param.select("scope", "Hull around", {
        options: [
          { value: "Each feature", description: "Every geometry gets its own hull; attributes are kept." },
          { value: "The whole layer", description: "One hull around all geometries, as a single row." },
        ],
        default: "Each feature",
        description: "Whether each feature gets its own hull, or one hull encloses the whole layer.",
      }),
    ],
    build: (source, params) => (whole(params) ? `ST_ConvexHull(ST_Union_Agg(${source}))` : `ST_ConvexHull(${source})`),
    collapses: whole,
  }),
);

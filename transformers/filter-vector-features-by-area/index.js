// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  toCrs,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Analysis",
  id: "FilterVectorFeaturesByArea",
  summary: "Keeps features whose area falls between two bounds in hectares; the rest are removed.",
  description:
    "FilterVectorFeaturesByArea measures every polygon's area in hectares, in an equal-area projection " +
    "(EPSG:6933) entered from the stream's actual coordinate system, and sends it to Kept when the area " +
    "is at least the minimum and at most the maximum, or to Removed otherwise. A blank maximum means no " +
    "upper limit. A Tester could express this, but only once you know to write the projection into the " +
    "predicate yourself, which is the step that is easy to get wrong; here the units are hectares and the " +
    "projection is taken care of. Features with no area (points, lines) measure 0.",
  whenToUse: [
    "drop slivers smaller than half a hectare",
    "keep plots between 1 and 5 hectares",
    "separate large parcels from small ones",
  ],
  whenNotToUse: [
    "filtering on any other attribute — use Tester",
    "adding the area as an attribute — use AddGeometryAttributes",
  ],
  keywords: ["area filter", "hectares", "size", "slivers", "minimum area", "polygon area"],
  examples: [
    {
      input: "squares of 121 ha and 484 ha",
      params: "Minimum 100, Maximum 300",
      output: "Kept: the 121 ha square; Removed: the 484 ha one",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "kept", label: "Kept", description: "Features whose area lies within the bounds." },
    { id: "removed", label: "Removed", description: "Features smaller than the minimum or larger than the maximum." },
  ],
  params: [
    param.string("min", "Minimum area (ha)", {
      default: "0",
      units: "ha",
      description: "The smallest area, in hectares, that a feature may have to be kept.",
    }),
    param.string("max", "Maximum area (ha)", {
      placeholder: "no limit",
      units: "ha",
      description: "The largest area, in hectares, that a kept feature may have; blank means no upper limit.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("FilterVectorFeaturesByArea needs a geometry column.");
    const area = `ST_Area(${toCrs(geometryExpression(geometry), ctx.incomingCrs, "EPSG:6933")}) / 10000`;
    const min = Number(ctx.params.min ?? 0);
    const max = ctx.params.max?.trim() ? Number(ctx.params.max) : null;
    if (!Number.isFinite(min) || (max !== null && !Number.isFinite(max)))
      throw new Error("Area bounds must be numbers of hectares.");
    const test = [`${area} >= ${min}`, max === null ? null : `${area} <= ${max}`].filter(Boolean).join(" AND ");
    return {
      kept: `SELECT * FROM ${ctx.inputs.input} WHERE ${test}`,
      removed: `SELECT * FROM ${ctx.inputs.input} WHERE NOT (${test})`,
    };
  },
});

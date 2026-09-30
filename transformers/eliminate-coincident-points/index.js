// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Geometry",
  id: "EliminateCoincidentPoints",
  summary: "Drops points that share a location, within a tolerance, keeping one per spot.",
  description:
    'EliminateCoincidentPoints keeps one point per location and drops the others. "Same location" ' +
    "allows a tolerance: coordinates are snapped to a grid of that size and the first point in each grid " +
    "cell wins, which keeps the work a grouping rather than a comparison of every pair. Points that are " +
    "closer than the tolerance but fall in neighbouring cells can both survive. The tolerance is in the " +
    "stream's own units — degrees on longitude/latitude. Which of several coincident points is kept is not " +
    "guaranteed. It works on point geometries and refuses a zero tolerance.",
  whenToUse: [
    "drop GPS fixes recorded twice at the same spot",
    "thin points that pile up at one location",
    "clean duplicated sample sites",
  ],
  whenNotToUse: [
    "rows that are identical in every attribute — use DuplicateFilter",
    "merging nearby polygons — use Dissolver",
  ],
  keywords: ["duplicate points", "coincident", "snap", "dedupe points", "thin", "near duplicates"],
  examples: [
    {
      input: "points (1 1), (1.001 1.001), (5 5)",
      params: "Tolerance 0.01",
      output: "two points: one near (1 1), and (5 5)",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "One point per location, with its own attributes." }],
  params: [
    param.string("tolerance", "Tolerance (degrees)", {
      default: "0.00001",
      units: "degrees",
      description:
        "The grid size within which points count as coincident, in the stream's own units (degrees on lon/lat).",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("EliminateCoincidentPoints needs a geometry column.");
    const tolerance = Number(ctx.params.tolerance ?? 0.00001);
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("Tolerance must be above zero.");
    const source = geometryExpression(geometry);
    const cell = `(round(ST_X(${source}) / ${tolerance}), round(ST_Y(${source}) / ${tolerance}))`;
    return {
      output: `SELECT * EXCLUDE (_pv_rn) FROM (SELECT *, row_number() OVER (PARTITION BY ${cell}) AS _pv_rn FROM ${ctx.inputs.input}) WHERE _pv_rn = 1`,
    };
  },
});

// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "BoundingBoxReplacer",
  group: "Reshape",
  summary: "Replaces geometry with its bounding box, per feature or one box for the whole input.",
  description:
    "BoundingBoxReplacer swaps each geometry for its axis-aligned bounding box — the smallest rectangle " +
    "with sides along the axes that contains it — and, by default, adds its minx, miny, maxx and maxy as " +
    "attributes, since those numbers are usually the point. In One box for everything mode the whole input " +
    "collapses to a single row holding the extent of all the features; no other attributes survive, since " +
    "one row cannot carry every row's values. The box is a real GEOMETRY, visible to the map and the " +
    "writers. It does not rotate the box to fit the shape — MinimumBoundingBox does that.",
  whenToUse: [
    "the extent of a whole layer as one rectangle with its bounds",
    "replace detailed shapes by their envelopes to draw faster",
    "add each feature's bounds as columns",
  ],
  whenNotToUse: [
    "the tightest rectangle at any angle — use MinimumBoundingBox",
    "a convex outline — use MinimumConvexHull",
  ],
  keywords: ["bounding box", "envelope", "extent", "bbox", "bounds", "rectangle", "minx"],
  examples: [
    {
      input: "two points (0 0) and (3 4)",
      params: "One box for everything",
      output: "one row: the rectangle 0 0 – 3 4 with minx 0, miny 0, maxx 3, maxy 4",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "The rows with their bounding boxes, or a single row with the overall box.",
    },
  ],
  params: [
    param.select("mode", "Box", {
      options: [
        { value: "Per feature", description: "Each geometry becomes its own box; attributes are kept." },
        {
          value: "One box for everything",
          description: "The whole input collapses to one row: the extent of all features.",
        },
      ],
      default: "Per feature",
      description: "Whether every feature gets its own box, or the whole input becomes one box.",
    }),
    param.select("bounds", "Bounds attributes", {
      options: [
        { value: "Add minx/miny/maxx/maxy", description: "Add the box's corners as four numeric attributes." },
        { value: "None", description: "Only replace the geometry." },
      ],
      default: "Add minx/miny/maxx/maxy",
      description: "Whether to add the box's minimum and maximum coordinates as attributes next to it.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("This input has no geometry to replace.");
    const column = qid(geometry.name);
    const source = geometryExpression(geometry);
    const wanted = (ctx.params.bounds ?? "Add minx/miny/maxx/maxy") !== "None";
    const input = ctx.inputs.input;
    if ((ctx.params.mode ?? "Per feature") === "One box for everything") {
      const united = `ST_Extent_Agg(${source})`;
      const bounds = wanted
        ? `, ST_XMin(${united}) AS minx, ST_YMin(${united}) AS miny, ST_XMax(${united}) AS maxx, ST_YMax(${united}) AS maxy`
        : "";
      return { output: `SELECT ${united} AS ${column}${bounds} FROM ${input}` };
    }
    // ST_Envelope, not ST_Extent: the latter is DuckDB's BOX type, which is not a GEOMETRY.
    const bounds = wanted
      ? `, ST_XMin(${source}) AS minx, ST_YMin(${source}) AS miny, ST_XMax(${source}) AS maxx, ST_YMax(${source}) AS maxy`
      : "";
    return { output: `SELECT * EXCLUDE (${column}), ST_Envelope(${source}) AS ${column}${bounds} FROM ${input}` };
  },
});

// @ts-check
// Pattern 3 — a crs hook: the transformer says what coordinate system its output is in, and the compiler
// carries that label down the graph. check() refuses a CRS PROJ does not know before anything is published.
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  query,
  toCrs,
  LONLAT,
} from "../../transformers/_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "ExampleLabelCrs",
  group: "Geometry",
  summary: "Example: labels the stream with a coordinate system, moving nothing.",
  description:
    "A reference transformer for the crs hook pattern, a stripped-down CoordinateSystemSetter. Its SQL " +
    "passes rows through untouched; its crs() hook returns the coordinate system you name, which every " +
    "node below then sees as ctx.incomingCrs; and its check() hook probes PROJ with the name so a typo is " +
    "refused at this node. It exists to be read: CoordinateSystemSetter is the real one.",
  whenToUse: ["read this before writing a transformer that changes the stream's CRS", "see how check() refuses a node"],
  whenNotToUse: ["real graphs — use CoordinateSystemSetter"],
  keywords: ["example", "reference", "crs hook"],
  examples: [{ input: "points", params: "CRS = EPSG:2056", output: "the same points, labelled EPSG:2056" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows, labelled in the chosen CRS." }],
  params: [
    param.string("crs", "CRS", {
      description: "The coordinate system to label the stream with, as a code PROJ knows.",
    }),
  ],
  sql: (ctx) => ({ output: `SELECT * FROM ${ctx.inputs.input}` }),
  crs: (ctx) => ctx.params.crs || ctx.incomingCrs,
  check: async (ctx) => {
    if (!ctx.params.crs || ctx.params.crs === LONLAT) return;
    await query(`SELECT ${toCrs("ST_Point(0, 0)", ctx.params.crs, LONLAT)} AS probe`);
  },
});

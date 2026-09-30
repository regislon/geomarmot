// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  toCrs,
  query,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

const destination = (params) => (params.to || "").trim();

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Geometry",
  id: "Reprojector",
  summary: "Moves geometry from the stream's coordinate system into another one.",
  description:
    "Reprojector transforms every geometry from the coordinate system the stream is in into the one you " +
    "name, and relabels the stream, so every node below knows where it now is: the map brings it back to " +
    "longitude/latitude to draw, the measuring nodes enter their equal-area projection from it, the writers " +
    "record it, and the H3 nodes refuse it. The destination is anything PROJ accepts — EPSG and ESRI codes, " +
    "or a +proj= string — and it is tried once when the graph is built, so a typo is a red node at once " +
    "rather than an empty map later. Axis order is always x, then y. It needs a geometry column.",
  whenToUse: [
    "export in Swiss LV95 (EPSG:2056)",
    "bring a projected stream back to lon/lat",
    "measure in a local metric system",
  ],
  whenNotToUse: [
    "coordinates that are right but mislabelled — use CoordinateSystemSetter",
    "a file with a wrong CRS — use the Reader's CRS override",
  ],
  keywords: ["reproject", "transform", "projection", "crs", "epsg", "convert coordinates", "warp"],
  examples: [
    {
      input: "Bern at 7.4386°E 46.9511°N",
      params: "Destination EPSG:2056",
      output: "POINT (2600000 1200000), stream labelled EPSG:2056",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The rows with geometry in the destination CRS." }],
  params: [
    param.string("to", "Destination CRS", {
      placeholder: "EPSG:2056, ESRI:54009, +proj=moll",
      description: "The coordinate system to move the geometry into, as an EPSG or ESRI code or a PROJ string.",
    }),
  ],
  needs: { schema: true },
  crs: (ctx) => destination(ctx.params) || ctx.incomingCrs,
  sql: (ctx) => {
    const to = destination(ctx.params);
    if (!to) throw new Error("Set a destination coordinate system, such as EPSG:2056.");
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("This input has no geometry to reproject.");
    if (to === ctx.incomingCrs) return { output: `SELECT * FROM ${ctx.inputs.input}` };
    const column = qid(geometry.name);
    const moved = toCrs(geometryExpression(geometry), ctx.incomingCrs, to);
    return { output: `SELECT * EXCLUDE (${column}), ${moved} AS ${column} FROM ${ctx.inputs.input}` };
  },
  check: async (ctx) => {
    const to = destination(ctx.params);
    if (!to || to === ctx.incomingCrs) return;
    try {
      await query(`SELECT ${toCrs("ST_Point(0, 0)", ctx.incomingCrs, to)} AS probe`);
    } catch (err) {
      throw new Error(`PROJ does not know "${to}" (${err.message})`);
    }
  },
});

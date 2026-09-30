// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, toCrs, LONLAT } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Geometry",
  id: "CoordinateSystemSetter",
  summary: "Labels the stream with a coordinate system without changing any coordinates.",
  description:
    "CoordinateSystemSetter says what the coordinates already are, and changes none of them. The " +
    "coordinate system belongs to the stream, so every node below takes the new label: the map reprojects " +
    "from it to draw, a Reprojector reprojects from it, the measuring nodes enter their equal-area " +
    "projection from it, and the writers name it. The typical use is points built mid-graph from projected " +
    "coordinates — a spreadsheet of Swiss E/N values — which are EPSG:2056 however the stream was labelled. " +
    "It does not check the choice against the data, but it does check that PROJ knows the name.",
  whenToUse: [
    "label points made from Swiss E/N columns as EPSG:2056",
    "fix a stream that was labelled with the wrong CRS",
    "declare the CRS of coordinates computed in SQL",
  ],
  whenNotToUse: [
    "moving coordinates into another system — use Reprojector",
    "a file whose CRS is missing or wrong — the Reader's CRS override fixes it at the source",
  ],
  keywords: ["coordinate system", "crs", "projection", "epsg", "assign", "label", "define projection"],
  examples: [
    {
      input: "points at (2600000 1200000) labelled lon/lat",
      params: "EPSG:2056",
      output: "the same points, now known to be LV95",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "output", label: "Output", description: "The same rows, with the stream labelled in the chosen CRS." },
  ],
  params: [
    param.string("crs", "Coordinate System", {
      placeholder: "EPSG:2056, ESRI:54009, +proj=moll",
      description: "The coordinate system the coordinates are really in, as an EPSG or ESRI code or a PROJ string.",
    }),
  ],
  crs: (ctx) => (ctx.params.crs || "").trim() || ctx.incomingCrs,
  sql: (ctx) => {
    if (!(ctx.params.crs || "").trim()) throw new Error("Set the coordinate system to assign, such as EPSG:2056.");
    return { output: `SELECT * FROM ${ctx.inputs.input}` };
  },
  // Not checked against the data — but a name PROJ cannot resolve would only fail later, at the map.
  check: async (ctx) => {
    const crs = (ctx.params.crs || "").trim();
    if (!crs || crs === LONLAT) return;
    try {
      await ctx.engine.query(`SELECT ${toCrs("ST_Point(0, 0)", crs, LONLAT)} AS probe`);
    } catch (err) {
      throw new Error(`PROJ does not know "${crs}" (${err.message})`);
    }
  },
});

// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  toCrs,
  LONLAT,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

const MEASURES = ["Area (ha)", "Perimeter (km)", "Vertices", "Geometry type", "Parts", "Centroid lon/lat"];

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "Analysis",
  id: "AddGeometryAttributes",
  summary: "Adds measurements of each shape as attributes: area, perimeter, vertices, type and more.",
  description:
    "AddGeometryAttributes measures every geometry and writes the results as new attributes: area in " +
    "hectares, perimeter in kilometres, vertex count, geometry type, number of parts, and the centroid's " +
    "longitude and latitude. Area and perimeter are measured in an equal-area projection (EPSG:6933, " +
    "within about 0.7% anywhere), entered from whatever coordinate system the stream is actually in, " +
    "rather than in degrees or with the spheroid functions, which on this engine report the same area for " +
    "a square degree at every latitude. Existing attributes and the geometry are kept. It needs a geometry column.",
  whenToUse: [
    "add each plot's area in hectares",
    "flag multi-part features by their part count",
    "add centroid coordinates for a spreadsheet",
  ],
  whenNotToUse: [
    "keeping only features above an area — FilterVectorFeaturesByArea does the measuring for you",
    "areas of a projected stream in its own units — write ST_Area in an AttributeCreator",
  ],
  keywords: ["area", "perimeter", "hectares", "measure", "geometry attributes", "vertex count", "centroid coordinates"],
  examples: [{ input: "a 0.01° square near 10°N", params: "Area (ha)", output: "the same row with area_ha ≈ 121" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows with the chosen measurements added." }],
  params: [
    param.choices("measures", "Add", {
      choices: MEASURES,
      default: ["Area (ha)", "Perimeter (km)", "Geometry type"],
      description: "Which measurements to add as attributes; area is in hectares and perimeter in kilometres.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) throw new Error("AddGeometryAttributes needs a geometry column.");
    const source = geometryExpression(geometry);
    const metric = toCrs(source, ctx.incomingCrs, "EPSG:6933");
    const lonlat = toCrs(source, ctx.incomingCrs, LONLAT);
    const wanted = new Set(ctx.params.measures || []);
    const additions = [];
    if (wanted.has("Area (ha)")) additions.push(`ST_Area(${metric}) / 10000 AS area_ha`);
    if (wanted.has("Perimeter (km)")) additions.push(`ST_Perimeter(${metric}) / 1000 AS perimeter_km`);
    if (wanted.has("Vertices")) additions.push(`ST_NPoints(${source}) AS vertices`);
    if (wanted.has("Geometry type")) additions.push(`ST_GeometryType(${source}) AS geometry_type`);
    if (wanted.has("Parts")) additions.push(`ST_NumGeometries(${source}) AS parts`);
    if (wanted.has("Centroid lon/lat")) {
      additions.push(`ST_X(ST_Centroid(${lonlat})) AS centroid_lon`, `ST_Y(ST_Centroid(${lonlat})) AS centroid_lat`);
    }
    return {
      output: additions.length
        ? `SELECT *, ${additions.join(", ")} FROM ${ctx.inputs.input}`
        : `SELECT * FROM ${ctx.inputs.input}`,
    };
  },
});

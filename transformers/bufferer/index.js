// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  qlit,
  toCrs,
  LONLAT,
  findGeometryColumn,
  geometryExpression,
} from "../_kit/index.js";

/*
 * Where a buffer is measured. Each entry builds the PROJ definition for one
 * feature from its own centroid, so a file spanning several zones or
 * hemispheres still buffers correctly row by row; null means no projection.
 */
const BUFFER_PROJECTIONS = {
  // Distances from the centre are true, which is exactly what a buffer needs.
  azimuthal_equidistant: (geom) =>
    `'+proj=aeqd +lat_0=' || ST_Y(ST_Centroid(${geom})) || ' +lon_0=' || ST_X(ST_Centroid(${geom})) || ' +datum=WGS84 +units=m'`,
  // The zone of the centroid, 326xx north and 327xx south.
  individual_utm: (geom) =>
    `'EPSG:' || ((CASE WHEN ST_Y(ST_Centroid(${geom})) >= 0 THEN 32600 ELSE 32700 END) + ` +
    `least(60, greatest(1, floor((ST_X(ST_Centroid(${geom})) + 180) / 6) + 1)))::INT::VARCHAR`,
  same_as_feature: null,
};

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Bufferer",
  group: "Reshape",
  summary: "Buffers every feature by a distance in metres, in a projection chosen per feature.",
  description:
    "Bufferer grows every geometry by a distance. Because the distance is in metres, the geometry leaves " +
    "longitude/latitude before ST_Buffer touches it: by default into an azimuthal equidistant projection " +
    "centred on the feature's own centroid, which keeps distances from the centre true anywhere on Earth, " +
    "and back again afterwards. individual_utm uses the UTM zone of the centroid instead. same_as_feature " +
    "does not reproject and buffers in the stream's own units — degrees on lon/lat. A projected stream is " +
    "taken to lon/lat for the per-feature projections and brought back. It needs a geometry column.",
  whenToUse: [
    "a 1 km zone around every mill",
    "a 500 m buffer around plots anywhere in the world",
    "grow shapes by a distance in the stream's own units",
  ],
  whenNotToUse: [
    "shrinking shapes by simplifying their outline — use SimplifyFeatures",
    "the smallest circle around a feature — use MinimumBoundingCircle",
  ],
  keywords: ["buffer", "zone", "distance", "around", "radius", "grow", "offset"],
  examples: [
    {
      input: "a point at 8.5, 47.4",
      params: "Distance 1000, azimuthal_equidistant",
      output: "a 32-sided polygon about 1 km in radius, in lon/lat",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows with each geometry replaced by its buffer." }],
  params: [
    param.string("distance", "Distance (m)", {
      default: "1000",
      units: "m",
      description:
        "How far to buffer, in metres for the per-feature projections, or in the stream's own units for same_as_feature.",
    }),
    param.select("crs", "Coordinate system", {
      options: [
        {
          value: "azimuthal_equidistant",
          description: "A projection centred on each feature; distances from the centre are true.",
        },
        { value: "individual_utm", description: "The UTM zone of each feature's centroid." },
        {
          value: "same_as_feature",
          description: "No reprojection: the distance is in the stream's own units (degrees on lon/lat).",
        },
      ],
      default: "azimuthal_equidistant",
      description: "The coordinate system each feature is buffered in, which decides what the distance is measured in.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const geometry = findGeometryColumn(ctx.schemas?.input || []);
    if (!geometry) {
      throw new Error(
        "This input has no geometry to buffer. If it came from PolygonToH3, set its Geometry to Hexagons — or add an H3GeometryFromIndex before this node.",
      );
    }
    const distance = Number(ctx.params.distance ?? 1000);
    if (!Number.isFinite(distance)) throw new Error("Distance must be a number of metres.");
    const source = geometryExpression(geometry);
    const projection = BUFFER_PROJECTIONS[ctx.params.crs || "azimuthal_equidistant"];
    const base = toCrs(source, ctx.incomingCrs, LONLAT);
    const buffered = projection
      ? toCrs(
          `ST_Transform(ST_Buffer(ST_Transform(${base}, ${qlit(LONLAT)}, ${projection(base)}, always_xy := true), ` +
            `${distance}), ${projection(base)}, ${qlit(LONLAT)}, always_xy := true)`,
          LONLAT,
          ctx.incomingCrs,
        )
      : `ST_Buffer(${source}, ${distance})`;
    const column = qid(geometry.name);
    return { output: `SELECT * EXCLUDE (${column}), ${buffered} AS ${column} FROM ${ctx.inputs.input}` };
  },
});

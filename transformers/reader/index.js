// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  qid,
  qlit,
  geometryExpression,
  isLonLat,
  LONLAT,
} from "../_kit/index.js";

/**
 * The CRS to read a source's geometry as, or null when it is not known. A CRS
 * the file did not actually declare (`assumed`) is not good enough to reproject
 * from: transforming out of a guessed CRS moves the data somewhere confidently
 * wrong. The override exists for exactly that case.
 */
function effectiveCrs(params, source) {
  const override = (params.crs || "").trim();
  if (override) return { code: override, assumed: false };
  return source.crs && !source.crs.assumed ? source.crs : null;
}

function reprojectionFor(params, source) {
  if (!source?.geometry) return null;
  const crs = effectiveCrs(params, source);
  return crs && !isLonLat(crs) ? crs : null;
}

/**
 * Whether to expose the physical row number. Parquet only: file_row_number is
 * an option of DuckDB's parquet reader, and `row_number() OVER ()` would be wrong
 * — a parallel scan makes no promise that a window sees rows in file order.
 */
function rowNumberWanted(params, source) {
  if (source.format !== "parquet") return false;
  const mode = params.rowNumber || "Auto";
  if (mode === "Yes") return true;
  if (mode === "No") return false;
  return source.h3?.mode === "positional";
}

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Reader",
  group: "Source",
  role: "source",
  summary: "Reads one loaded file or layer into the graph, as longitude/latitude.",
  description:
    "The Reader is where every graph starts. It reads one source from the Layers rail — a Parquet or " +
    "GeoParquet file, a GeoPackage or GeoJSON layer, a CSV, an Excel sheet or a Zarr array snapshot — " +
    "and hands its rows downstream. Geometry in a projected coordinate system is reprojected to " +
    "longitude/latitude on read, so everything below a Reader starts in EPSG:4326. It never guesses a " +
    "coordinate system the file does not declare; use the CRS override for that. It does not build " +
    "geometry from coordinate columns (use VertexCreator) and does not derive H3 indexes (use the H3 transformers).",
  whenToUse: [
    "start a graph from a file I dropped or loaded from a URL",
    "read a layer whose coordinate system is missing or wrong, by setting the CRS override",
    "keep the physical row order of a Parquet file for positional H3 tiles",
  ],
  whenNotToUse: [
    "turning lon/lat or E/N columns into points — that is VertexCreator",
    "changing the coordinate system mid-graph — that is Reprojector",
  ],
  keywords: ["source", "input", "open", "file", "load", "parquet", "geopackage", "csv", "excel"],
  examples: [
    {
      input: "a GeoPackage layer in EPSG:2056",
      params: "Source = the layer",
      output: "its rows, with geometry reprojected to longitude/latitude",
    },
  ],
  inputs: [],
  outputs: [{ id: "output", label: "Output", description: "Every row of the source, geometry in longitude/latitude." }],
  params: [
    param.source("sourceId", "Source", {
      description: "Which loaded file or layer this Reader reads, chosen from the Layers rail.",
    }),
    param.string("crs", "CRS override", {
      placeholder: "e.g. EPSG:3857",
      description:
        "The coordinate system to read the geometry as, for a file that declares none or the wrong one. Blank uses the file's own.",
    }),
    param.select("rowNumber", "Row number", {
      options: [
        { value: "Auto", description: "Yes for a dense positional H3 tile, no for everything else." },
        { value: "Yes", description: "Add file_row_number, the physical row order (Parquet only)." },
        { value: "No", description: "Do not add a row number." },
      ],
      default: "Auto",
      description: "Whether to add the physical row number as file_row_number, which PositionalH3Index needs.",
    }),
  ],
  aiUsable: false,
  sql: (ctx) => {
    const source = ctx.sources.get(ctx.params.sourceId);
    if (!source) throw new Error("Reader has no source.");
    const relation = ctx.sources.relation(source, { rowNumber: rowNumberWanted(ctx.params, source) });
    const reprojection = reprojectionFor(ctx.params, source);
    if (!reprojection) return { output: `SELECT * FROM ${relation}` };
    const column = qid(source.geometry.name);
    const moved = `ST_Transform(${geometryExpression(source.geometry)}, ${qlit(reprojection.code)}, 'EPSG:4326', always_xy := true)`;
    return { output: `SELECT * EXCLUDE (${column}), ${moved} AS ${column} FROM ${relation}` };
  },
  crs: () => LONLAT,
});

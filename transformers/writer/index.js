// @ts-check
import { defineTransformer, API_VERSION, param, writeView } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Writer",
  group: "Output",
  role: "sink",
  summary: "Writes what reaches it to a file: Parquet, GeoParquet, GeoJSON, GeoPackage, CSV or Excel.",
  description:
    "The Writer is where a graph ends. It writes the rows arriving at its input to one file, which the " +
    "browser saves to your downloads; nothing is uploaded. It runs only when you ask — Run in the " +
    "toolbar writes every connected Writer, and Write this file writes just one — because every other " +
    "node is a lazy view. GeoParquet carries valid geo metadata, GeoJSON names a projected CRS, and Excel " +
    "keeps 64-bit integers exact and geometry as WKT. It does not write to cloud buckets.",
  whenToUse: ["save the result of a graph as a GeoParquet file", "export a table for a spreadsheet user as Excel"],
  whenNotToUse: ["looking at intermediate results — every node is already inspectable in the table and the map"],
  keywords: ["output", "export", "save", "download", "write", "file", "geojson", "excel", "csv"],
  examples: [
    {
      input: "points from a VertexCreator",
      params: "Format = GeoJSON, File name = sites",
      output: "sites.geojson in your downloads",
    },
  ],
  inputs: [{ id: "input", label: "Input", description: "The rows to write." }],
  outputs: [],
  params: [
    param.select("format", "Format", {
      options: [
        { value: "Parquet", description: "Columnar and compact; geometry as DuckDB writes it." },
        { value: "GeoParquet", description: "Parquet with geo metadata, readable by GIS tools." },
        { value: "GeoJSON", description: "Text, one feature per row; lon/lat unless the stream is projected." },
        {
          value: "GeoPackage",
          description:
            "One layer in an SQLite GeoPackage, in the stream's own coordinate system, readable by QGIS and GDAL.",
        },
        { value: "CSV", description: "Plain text table, geometry dropped to text." },
        { value: "Excel", description: "One sheet, geometry as WKT, Excel's row and cell limits enforced." },
      ],
      default: "Parquet",
      description: "The file format to write, which decides how geometry and wide numbers are stored.",
    }),
    param.string("filename", "File name", {
      default: "output",
      description: "The name of the downloaded file, without its extension; unsafe characters become underscores.",
    }),
  ],
  action: { id: "export", label: "Write this file" },
  aiUsable: false,
  write: (ctx) =>
    writeView(ctx.inputs.input, ctx.params.format || "Parquet", ctx.params.filename || "output", ctx.incomingCrs),
});

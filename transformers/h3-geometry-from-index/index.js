// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  LONLAT,
  sampleStep,
  sampleWhere,
  buildCellTable,
  SAMPLE_STEPS,
  H3_INDEX_COLUMN,
} from "../_kit/index.js";

const SAMPLE_DESCRIPTIONS = { Auto: "Aim for about 50,000 cells.", All: "Every cell." };

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "H3",
  id: "H3GeometryFromIndex",
  summary: "Builds hexagon geometry from an existing H3 index column.",
  description:
    "H3GeometryFromIndex turns an attribute holding H3 cell indexes into real hexagon geometry, so a table " +
    "of cells can be buffered, dissolved, joined spatially or exported as GeoParquet. The hexagons are " +
    "built in JavaScript with h3-js and materialised, which is why there is a Sample every Nth setting: " +
    "sampling is by a hash of the index, applied identically when building and when joining back, so rows " +
    "never lose their geometry — sampled-out rows are left out. Auto aims for about fifty thousand cells; " +
    "All keeps every one, up to two million. Rows with no index are dropped. The output is longitude/latitude.",
  whenToUse: [
    "hexagons for a table that has an h3_index column",
    "export H3 cells as GeoParquet",
    "dissolve H3 cells into regions",
  ],
  whenNotToUse: [
    "a dense positional tile with no index column — use H3GeometryFromPosition",
    "just seeing the cells on the map — the map draws an h3_index column directly",
  ],
  keywords: ["h3", "hexagon", "cell to boundary", "cell geometry", "index to polygon"],
  examples: [
    {
      input: "rows with h3_index 8a1f8d7a49a7fff and 8a1f8d7a49b7fff",
      params: "Sample All",
      output: "the same rows with their hexagons as geometry",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "output", label: "Output", description: "The sampled rows with each cell's hexagon added as geometry." },
  ],
  params: [
    param.column("indexColumn", "Index attribute", {
      description: "The attribute holding the H3 cell indexes, as text or as integers.",
    }),
    param.select("sample", "Sample every Nth", {
      options: SAMPLE_STEPS.map((value) => ({
        value,
        description: SAMPLE_DESCRIPTIONS[value] || `One cell in ${value}.`,
      })),
      default: "Auto",
      description: "How many cells to build hexagons for: all, one in N, or enough for about 50,000.",
    }),
    param.string("geometryColumn", "Geometry attribute", {
      default: "geometry",
      description: "The name of the new geometry attribute holding each row's hexagon.",
    }),
  ],
  needs: { rowCount: true },
  crs: () => LONLAT,
  prepare: async (ctx) => {
    const column = qid(ctx.params.indexColumn || H3_INDEX_COLUMN);
    // Sampled on a hash of the index, so the same cells are chosen here and in the join.
    const where = sampleWhere(sampleStep(ctx), `hash(${column})`);
    const notNull = where ? `${where} AND ${column} IS NOT NULL` : ` WHERE ${column} IS NOT NULL`;
    await buildCellTable(ctx, `SELECT DISTINCT ${column} AS cell FROM ${ctx.inputs.input}${notNull}`);
  },
  sql: (ctx) => {
    const column = qid(ctx.params.indexColumn || H3_INDEX_COLUMN);
    const where = sampleWhere(sampleStep(ctx), `hash(v.${column})`);
    return {
      output:
        `SELECT v.*, g.geometry AS ${qid(ctx.params.geometryColumn || "geometry")} FROM ${ctx.inputs.input} v ` +
        `JOIN ${ctx.tableName("cells")} g ON v.${column} = g.cell${where}`,
    };
  },
});

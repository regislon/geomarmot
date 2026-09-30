// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  LONLAT,
  positionalExprFor,
  sampleStep,
  sampleWhere,
  buildCellTable,
  SAMPLE_STEPS,
  ROW_NUMBER_COLUMN,
  H3_INDEX_COLUMN,
} from "../_kit/index.js";

const SAMPLE_DESCRIPTIONS = { Auto: "Aim for about 50,000 cells.", All: "Every cell." };

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "H3",
  id: "H3GeometryFromPosition",
  summary: "Turns a dense positional tile's row order straight into indexes and hexagons.",
  description:
    "H3GeometryFromPosition does PositionalH3Index and H3GeometryFromIndex in one step: each row of a " +
    "dense positional H3 tile gets its h3_index from its file_row_number and its hexagon as geometry. The " +
    "parent cell comes from the file name and the child resolution from the row count unless you type them. " +
    "Hexagons are built in JavaScript and materialised, so rows can be sampled by row number — the same " +
    "filter when building and when joining, so no row loses its geometry; All keeps every cell up to two " +
    "million. It needs the Reader's Row number. The output is longitude/latitude.",
  whenToUse: [
    "hexagons for a dense tile in one node",
    "export a positional tile as GeoParquet with geometry",
    "see every cell of a small tile as a real polygon",
  ],
  whenNotToUse: [
    "only the index — PositionalH3Index is free and lazy",
    "a filter before the costly half — split into PositionalH3Index, a filter, then H3GeometryFromIndex",
  ],
  keywords: ["h3", "positional", "dense tile", "hexagons", "row order", "cell geometry"],
  examples: [
    {
      input: "891f8d7a49bffff.parquet, 7 rows, Row number = Yes",
      params: "Sample All",
      output: "7 rows with h3_index and their resolution-10 hexagons",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The sampled rows with h3_index and each cell's hexagon." }],
  params: [
    param.string("parent", "Parent cell", {
      placeholder: "from the file name",
      description: "The tile's parent H3 cell; blank takes it from the name of the file the Reader reads.",
    }),
    param.string("resolution", "Child resolution", {
      placeholder: "from the row count",
      description:
        "The resolution of the rows' cells; blank derives it from the row count, which must be a power of seven.",
    }),
    param.select("sample", "Sample every Nth", {
      options: SAMPLE_STEPS.map((value) => ({
        value,
        description: SAMPLE_DESCRIPTIONS[value] || `One row in ${value}.`,
      })),
      default: "Auto",
      description: "How many rows get a hexagon: all, one in N by row number, or enough for about 50,000.",
    }),
    param.string("geometryColumn", "Geometry attribute", {
      default: "geometry",
      description: "The name of the new geometry attribute holding each row's hexagon.",
    }),
  ],
  needs: { schema: true, rowCount: true },
  crs: () => LONLAT,
  prepare: async (ctx) => {
    const expr = positionalExprFor(ctx);
    const where = sampleWhere(sampleStep(ctx), qid(ROW_NUMBER_COLUMN));
    await buildCellTable(ctx, `SELECT DISTINCT ${expr} AS cell FROM ${ctx.inputs.input}${where}`);
  },
  sql: (ctx) => {
    const expr = positionalExprFor(ctx, "v");
    const where = sampleWhere(sampleStep(ctx), `v.${qid(ROW_NUMBER_COLUMN)}`);
    return {
      output:
        `SELECT v.* EXCLUDE (${qid(ROW_NUMBER_COLUMN)}), ${expr} AS ${qid(H3_INDEX_COLUMN)}, ` +
        `g.geometry AS ${qid(ctx.params.geometryColumn || "geometry")} FROM ${ctx.inputs.input} v ` +
        `JOIN ${ctx.tableName("cells")} g ON ${expr} = g.cell${where}`,
    };
  },
});

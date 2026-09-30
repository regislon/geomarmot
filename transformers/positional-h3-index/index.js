// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  resolveParent,
  resolveChildResolution,
  positionalIndexExpr,
  ROW_NUMBER_COLUMN,
  H3_INDEX_COLUMN,
} from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  group: "H3",
  id: "PositionalH3Index",
  summary: "Derives each row's H3 index from its position in a dense positional tile.",
  description:
    "PositionalH3Index recovers the h3_index column of a dense positional H3 tile: a file named after its " +
    "parent cell that holds all 7^n children of that cell in ascending order, and no cell column, so row i " +
    "is child i. The index is computed from the Reader's file_row_number with arithmetic on H3's bit layout " +
    "— sorted child order is base-7 counting in the index's digit fields — so it is lazy and free on all " +
    "823,543 rows of a resolution-6 tile. The parent comes from the file name and the resolution from the row " +
    "count, unless you type them. It needs the Reader's Row number, and refuses a pentagon parent or a row " +
    "count that is not a whole number of children.",
  whenToUse: [
    "turn a dense H3 tile's row order into an h3_index column",
    "index a tile before joining it to other H3 data",
    "see a tile on the map without building hexagons",
  ],
  whenNotToUse: [
    "hexagon geometry as well — use H3GeometryFromPosition",
    "files that already have an index column — use H3GeometryFromIndex",
  ],
  keywords: ["h3", "positional", "dense tile", "cell index", "row order", "hexagon index"],
  examples: [
    {
      input: "891f8d7a49bffff.parquet with 7 rows and Row number = Auto",
      params: "none",
      output: "the 7 resolution-10 children as h3_index, in order",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The rows with h3_index in place of file_row_number." }],
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
  ],
  needs: { schema: true, rowCount: true, lonLat: true },
  sql: (ctx) => {
    const parent = resolveParent(ctx);
    const resolution = resolveChildResolution(ctx, parent);
    if (!(ctx.schemas?.input || []).some((column) => column.name === ROW_NUMBER_COLUMN)) {
      throw new Error(
        `No "${ROW_NUMBER_COLUMN}" column — set the Reader's "Row number" to Yes so the row order survives.`,
      );
    }
    const expr = positionalIndexExpr(parent, resolution, qid(ROW_NUMBER_COLUMN));
    return {
      output: `SELECT * EXCLUDE (${qid(ROW_NUMBER_COLUMN)}), ${expr} AS ${qid(H3_INDEX_COLUMN)} FROM ${ctx.inputs.input}`,
    };
  },
});

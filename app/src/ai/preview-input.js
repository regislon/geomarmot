// @ts-check
/*
 * PreviewInput: where a draft preview's data comes from.
 *
 * A draft's inputs are outputs of the user's graph. For a preview they are
 * sampled (at most 1,000 rows) into Parquet in the main engine and loaded as a
 * table into the isolated preview engine; this source node reads that table,
 * with the CRS the upstream output had. Internal: never in the palette, Quick
 * Add or the catalogue, and it reads only the preview's own `pin_<n>` tables.
 */

import { API_VERSION, defineTransformer, param, qid } from "../../../transformers/_kit/index.js";
import { registerInternal } from "../../../transformers/index.js";

const TABLE = /^pin_\d+$/;

export const PreviewInput = defineTransformer({
  apiVersion: API_VERSION,
  id: "PreviewInput",
  group: "Internal",
  role: "source",
  summary: "A sampled copy of a graph output, feeding a draft preview in the preview engine.",
  outputs: [{ id: "output", label: "Output", description: "The sampled rows." }],
  params: [
    param.string("table", "Table", { description: "The preview engine table holding the sampled rows." }),
    param.string("crs", "CRS", { description: "The coordinate system the sampled output was in." }),
    param.string("blockedBy", "Blocked by", { description: "The graph node whose failure left nothing to sample." }),
  ],
  aiUsable: false,
  sql: (ctx) => {
    if (ctx.params.blockedBy) throw new Error(`Blocked: upstream error in ${ctx.params.blockedBy}.`);
    if (!TABLE.test(ctx.params.table || "")) throw new Error("PreviewInput reads only preview tables.");
    return { output: `SELECT * FROM ${qid(ctx.params.table)}` };
  },
  crs: (ctx) => ctx.params.crs || "EPSG:4326",
});

registerInternal(PreviewInput);

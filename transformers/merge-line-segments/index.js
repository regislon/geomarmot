// @ts-check
import { defineTransformer, API_VERSION, sqlGeometryTool } from "../_kit/index.js";

export default defineTransformer(
  sqlGeometryTool({
    apiVersion: API_VERSION,
    id: "MergeLineSegments",
    summary: "Joins line segments that share endpoints into longer lines, feature by feature.",
    description:
      "MergeLineSegments sews together the pieces of a multi-part line: wherever two segments of the same " +
      "feature meet end to end, they become one line, and a feature whose pieces all connect becomes a single " +
      "LINESTRING. Pieces that do not touch stay separate parts of a MULTILINESTRING. It works within each " +
      "feature, not across features — merge the features first with a Dissolver to join lines from several " +
      "rows. Geometries that are not lines pass through unchanged. It needs a geometry column.",
    whenToUse: [
      "tidy a road digitised as many small segments",
      "turn a multi-part line into one line where it connects",
      "prepare lines for measuring length per route",
    ],
    whenNotToUse: ["joining lines from different rows on its own — Dissolver first, then MergeLineSegments"],
    keywords: ["merge lines", "line merge", "join segments", "polyline", "connect", "sew"],
    examples: [
      {
        input: "MULTILINESTRING ((0 0, 1 0), (1 0, 2 1), (5 5, 6 6))",
        params: "none",
        output: "MULTILINESTRING ((0 0, 1 0, 2 1), (5 5, 6 6))",
      },
    ],
    outputDescription: "The rows with each line's connected segments merged.",
    params: [],
    build: (source) => `ST_LineMerge(${source})`,
  }),
);

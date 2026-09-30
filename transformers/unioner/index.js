// @ts-check
import { defineTransformer, API_VERSION, SINGLE_OUT } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Unioner",
  group: "Combine",
  summary: "Stacks two streams into one; columns are matched by name, missing ones become NULL.",
  description:
    "Unioner puts the rows of its Bottom input under the rows of its Top input. Columns are matched by " +
    "name rather than by position, so two files holding the same attributes in a different column order " +
    "still line up, and a column that only one side has is kept, with NULL for the other side's rows. " +
    "Duplicate rows are kept: this is UNION ALL, not a distinct union. Both inputs must be in the same " +
    "coordinate system. It does not match rows to each other — that is a join, FeatureJoiner.",
  whenToUse: [
    "stack two tiles of the same layer",
    "combine this year's and last year's tables",
    "append rows with an extra column to an existing table",
  ],
  whenNotToUse: [
    "matching rows on a key — use FeatureJoiner",
    "removing repeated rows afterwards — follow it with DuplicateFilter",
  ],
  keywords: ["union", "append", "stack", "concatenate", "merge rows", "combine"],
  examples: [
    {
      input: "top (id, name), bottom (name, id, extra)",
      params: "none",
      output: "one stream with id, name, extra; extra is NULL for the top rows",
    },
  ],
  inputs: [
    { id: "top", label: "Top", description: "The rows that come first." },
    { id: "bottom", label: "Bottom", description: "The rows appended under them." },
  ],
  outputs: SINGLE_OUT,
  params: [],
  sql: (ctx) => ({ output: `SELECT * FROM ${ctx.inputs.top} UNION ALL BY NAME SELECT * FROM ${ctx.inputs.bottom}` }),
});

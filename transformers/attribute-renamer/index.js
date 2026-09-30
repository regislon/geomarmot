// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeRenamer",
  group: "Attributes",
  summary: "Renames attributes and leaves their values and column order untouched.",
  description:
    "AttributeRenamer gives attributes new names. Each rename row maps an existing attribute to its new " +
    "name; values are not touched and the columns stay in their original order, so a renamed column is " +
    "still where it was. It writes every column out by name, because this engine's SQL has no RENAME " +
    "shorthand. Rows that are only half filled in are ignored while you type. It does not copy an attribute " +
    "under a second name — AttributeManager's Copy to does that.",
  whenToUse: [
    "rename E and N to x and y before sharing a file",
    "give columns from a spreadsheet clean names",
    "match the attribute names another tool expects",
  ],
  whenNotToUse: [
    "keeping the old name as well as the new one — use AttributeManager's Copy to",
    "changing values — use AttributeCreator or AttributeManager",
  ],
  keywords: ["rename", "alias", "field name", "column name", "attributes", "relabel"],
  examples: [{ input: "id, name, cat", params: "name → full_name", output: "id, full_name, cat" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows with the attributes renamed in place." }],
  params: [
    param.renames("renames", "Renames", {
      description: "Pairs of existing attribute and new name; incomplete pairs are ignored until both are filled in.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    const renames = new Map((ctx.params.renames || []).filter((r) => r.from && r.to).map((r) => [r.from, r.to]));
    const columns = ctx.schemas?.input || [];
    if (!renames.size || !columns.length) return { output: `SELECT * FROM ${ctx.inputs.input}` };
    const selection = columns
      .map((c) => (renames.has(c.name) ? `${qid(c.name)} AS ${qid(renames.get(c.name))}` : qid(c.name)))
      .join(", ");
    return { output: `SELECT ${selection} FROM ${ctx.inputs.input}` };
  },
});

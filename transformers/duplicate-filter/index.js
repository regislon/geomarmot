// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "DuplicateFilter",
  group: "Filters",
  summary: "Keeps the first row for each key and sends the others out of Duplicate.",
  description:
    "DuplicateFilter groups rows by the key attributes you choose and lets one row per key through " +
    "Unique; every further row with the same key comes out of Duplicate, so nothing is lost. Any " +
    "attribute can be part of the key, geometry included: DuckDB compares geometries directly, so " +
    '"same shape" is a duplicate test like any other. Which of several duplicates counts as the first is ' +
    "not guaranteed when they differ in other attributes. With no key chosen, every row is unique. It does " +
    "not merge the duplicates' attributes — use Aggregator for that.",
  whenToUse: [
    "drop repeated rows before a join",
    "keep one feature per identical geometry",
    "find ids that appear more than once",
  ],
  whenNotToUse: [
    "points that are only nearly in the same place — use EliminateCoincidentPoints",
    "combining the duplicates' values — use Aggregator",
  ],
  keywords: ["duplicate", "dedupe", "distinct", "unique", "remove duplicates", "repeated"],
  examples: [
    {
      input: "two identical rows (1, x) and one (2, y)",
      params: "Key = id, k",
      output: "Unique: (1, x), (2, y); Duplicate: (1, x)",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [
    { id: "unique", label: "Unique", description: "The first row for each distinct key." },
    { id: "duplicate", label: "Duplicate", description: "Every further row whose key was already seen." },
  ],
  params: [
    param.columns("keys", "Key attributes", {
      description: "The attributes that together decide whether two rows are duplicates; geometry is allowed.",
    }),
  ],
  sql: (ctx) => {
    const input = ctx.inputs.input;
    const keys = (ctx.params.keys || []).filter(Boolean);
    if (!keys.length) return { unique: `SELECT * FROM ${input}`, duplicate: `SELECT * FROM ${input} WHERE FALSE` };
    const numbered = `SELECT *, row_number() OVER (PARTITION BY ${keys.map(qid).join(", ")}) AS _pv_rn FROM ${input}`;
    return {
      unique: `SELECT * EXCLUDE (_pv_rn) FROM (${numbered}) WHERE _pv_rn = 1`,
      duplicate: `SELECT * EXCLUDE (_pv_rn) FROM (${numbered}) WHERE _pv_rn > 1`,
    };
  },
});

// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Sorter",
  group: "Reshape",
  summary: "Orders rows by one or more attributes, each ascending or descending.",
  description:
    "Sorter orders the rows of its input by the attributes you list, the first one deciding and each " +
    "later one breaking ties in the one before, every key ascending or descending. The order is what the " +
    "attribute grid shows and what a Writer writes, so sort just before exporting when the order matters to " +
    "whoever reads the file. NULLs sort last. It does not remove or change any row, and a transformer placed " +
    "after it is not promised to keep the order unless it says so.",
  whenToUse: [
    "export a table ordered by name",
    "show the largest areas first",
    "order by category, then by id within each category",
  ],
  whenNotToUse: ["keeping only the top N rows — follow the Sorter with a Sampler set to First N"],
  keywords: ["sort", "order by", "rank", "ascending", "descending", "arrange rows"],
  examples: [
    {
      input: "rows with cat, id",
      params: "cat DESC, then id ASC",
      output: "the same rows ordered by category descending, id within each",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows, in the chosen order." }],
  params: [
    param.sorts("sorts", "Sort by", {
      description: "The attributes to sort on, most important first, each ascending or descending.",
    }),
  ],
  sql: (ctx) => {
    const keys = (ctx.params.sorts || [])
      .filter((sort) => sort.column)
      .map((sort) => `${qid(sort.column)} ${sort.direction === "DESC" ? "DESC" : "ASC"}`);
    return { output: `SELECT * FROM ${ctx.inputs.input}${keys.length ? ` ORDER BY ${keys.join(", ")}` : ""}` };
  },
});

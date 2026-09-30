// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Sampler",
  group: "Reshape",
  summary: "Takes a subset of rows: the first N, every Nth, or a random percentage.",
  description:
    "Sampler passes on part of its input. First N keeps the first N rows as they arrive; Every Nth keeps " +
    "one row in N; Random % keeps each row independently with the given probability, so the size varies " +
    "from run to run around that share. It is the quickest way to try a chain against a big file before " +
    "running it on everything. Row order is the scan's order, fine for a sample but not something to rely " +
    "on positionally. An amount that is not a positive number passes every row through. It does not sample " +
    "within groups.",
  whenToUse: [
    "try a slow chain on the first 1000 rows of a big file",
    "keep a random 10% for a quick look",
    "thin a dense point layer to every 10th point",
  ],
  whenNotToUse: [
    "keeping the rows with the largest values — sort with a Sorter first",
    "sampling H3 cells by position — the H3 geometry nodes have their own sampling",
  ],
  keywords: ["sample", "subset", "limit", "first n", "random", "thin", "preview"],
  examples: [{ input: "rows 1–5", params: "Every Nth, N = 2", output: "rows 2 and 4" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The sampled rows, attributes unchanged." }],
  params: [
    param.select("mode", "How", {
      options: [
        { value: "First N", description: "The first N rows in scan order." },
        { value: "Every Nth", description: "One row in every N." },
        {
          value: "Random %",
          description: "Each row kept independently with this percent chance (Bernoulli sampling).",
        },
      ],
      default: "First N",
      description: "How rows are chosen: a head, a regular stride, or at random.",
    }),
    param.string("amount", "N (or percent)", {
      default: "1000",
      description: "The number of rows for First N, the stride for Every Nth, or the percentage for Random %.",
    }),
  ],
  sql: (ctx) => {
    const input = ctx.inputs.input;
    const amount = Number(ctx.params.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { output: `SELECT * FROM ${input}` };
    if (ctx.params.mode === "Random %") {
      // (bernoulli) is not optional: DuckDB's default system sampling picks whole vectors, so on a
      // small table it returns all the rows or none of them.
      return { output: `SELECT * FROM ${input} USING SAMPLE ${Math.min(100, amount)} PERCENT (bernoulli)` };
    }
    if (ctx.params.mode === "Every Nth") {
      const step = Math.max(1, Math.round(amount));
      return {
        output: `SELECT * EXCLUDE (_pv_rn) FROM (SELECT *, row_number() OVER () AS _pv_rn FROM ${input}) WHERE _pv_rn % ${step} = 0`,
      };
    }
    return { output: `SELECT * FROM ${input} LIMIT ${Math.round(amount)}` };
  },
});

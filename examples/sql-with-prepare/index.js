// @ts-check
/*
 * Pattern 2 — SQL + prepare: work DuckDB cannot do runs in prepare(), in
 * JavaScript, and lands in a table named with ctx.tableName(); sql() joins it
 * back. The rows are materialised with an id first, so results pair with the
 * rows they came from. Check ctx.signal between batches.
 */
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  FEATURE_ID_COLUMN,
  throwIfAborted,
} from "../../transformers/_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "ExampleReverseText",
  group: "Attributes",
  summary: "Example: adds an attribute holding a text attribute reversed, computed in JavaScript.",
  description:
    "A reference transformer for the SQL plus prepare pattern. prepare() copies the input into a table " +
    "with a row id, reads the chosen text attribute, reverses each value in JavaScript, and writes the " +
    "results into a second table; sql() joins the two. DuckDB could do this with reverse(), which is " +
    "exactly why this is only an example: real transformers use prepare for what SQL cannot do, such as " +
    "H3 fills and JSTS geometry.",
  whenToUse: [
    "read this before writing a transformer that needs a JavaScript library",
    "see how prepare tables are named and joined",
  ],
  whenNotToUse: ["real graphs — use reverse() in an AttributeCreator"],
  keywords: ["example", "reference", "prepare"],
  examples: [{ input: "name = abc", params: "Attribute = name", output: "name_reversed = cba" }],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The rows with the reversed attribute added." }],
  params: [
    param.column("column", "Attribute", {
      description: "The text attribute whose values are reversed into a new attribute.",
    }),
  ],
  prepare: async (ctx) => {
    const source = ctx.tableName("src");
    const results = ctx.tableName("reversed");
    await ctx.engine.exec(
      `CREATE TABLE ${source} AS SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${ctx.inputs.input}`,
    );
    const rows = await ctx.engine.query(
      `SELECT ${qid(FEATURE_ID_COLUMN)} AS id, ${qid(ctx.params.column)} AS v FROM ${source}`,
    );
    throwIfAborted(ctx.signal);
    await ctx.engine.exec(`CREATE TABLE ${results} (id BIGINT, reversed VARCHAR)`);
    for (const row of rows) {
      const value = row.v == null ? "NULL" : `'${String(row.v).split("").reverse().join("").replace(/'/g, "''")}'`;
      await ctx.engine.exec(`INSERT INTO ${results} VALUES (${row.id}, ${value})`);
    }
  },
  sql: (ctx) => ({
    output:
      `SELECT s.* EXCLUDE (${qid(FEATURE_ID_COLUMN)}), r.reversed AS ${qid(`${ctx.params.column}_reversed`)} ` +
      `FROM ${ctx.tableName("src")} s JOIN ${ctx.tableName("reversed")} r ON s.${qid(FEATURE_ID_COLUMN)} = r.id`,
  }),
});

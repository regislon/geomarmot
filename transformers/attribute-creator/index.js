// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  valueSql,
  spliceQuery,
  checkSql,
  SYNTAX_REFERENCE,
} from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeCreator",
  group: "Attributes",
  summary: "Adds attributes to every row, from a builder or from a DuckDB SELECT.",
  description:
    "AttributeCreator writes new attributes onto every row. In Builder mode each new attribute is a name " +
    "and a value: a constant of a chosen type, a copy of another attribute, a small formula (+ − × ÷ and " +
    "join text) over two operands, or a SQL expression. In SQL query mode you write the whole SELECT, with " +
    "the incoming rows available as the table `input`; keep `input.*` so the existing attributes survive. " +
    "A query that adds no attribute is refused, and SQL is checked as you type and again when the graph is " +
    "built. A new GEOMETRY column needs no extra wiring: the map, the table and the writers find it. It does " +
    "not remove or rename attributes.",
  whenToUse: [
    "add an area_ha column computed from the geometry",
    "make points from lon/lat columns with ST_Point(lon, lat)",
    "add a constant label or a copy of another attribute",
  ],
  whenNotToUse: [
    "points from coordinate columns with a coordinate system — VertexCreator does it and labels the stream",
    "renaming or removing attributes — AttributeRenamer, AttributeRemover, or AttributeManager for several edits",
    "a query that changes the rows, not just adds columns — use SQLTransformer",
  ],
  keywords: ["add field", "calculate", "field calculator", "expression", "new column", "computed", "sql", "formula"],
  examples: [
    { input: "rows with v", params: "Builder: double_v = v × 2", output: "the same rows with a new double_v column" },
    {
      input: "rows with lon, lat",
      params: "SQL query: SELECT input.*, ST_Point(lon, lat) AS geom FROM input",
      output: "the same rows with a point geometry",
    },
  ],
  help: {
    title: "AttributeCreator",
    intro: [
      "Writes new attributes onto every row. In SQL query mode the incoming stream is the table `input`: " +
        "keep `input.*` so the existing attributes survive, and add your new columns beside it.",
      "The schema panel lists the input's columns and types, and Copy for AI puts that schema together with " +
        "the rules below on the clipboard, so an assistant can write a query that compiles against this data.",
      "Everything is checked as you type, and again when the graph is built: a query that does not compile, " +
        "or that adds no attribute, stops at this node instead of quietly passing rows through unchanged.",
    ],
    code: SYNTAX_REFERENCE,
  },
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "Every input row with the new attributes added." }],
  params: [
    param.select("mode", "How", {
      options: [
        {
          value: "Builder",
          description: "Name each new attribute and pick its value: constant, attribute, formula or SQL.",
        },
        { value: "SQL query", description: "Write the whole SELECT over the table `input`." },
      ],
      default: "Builder",
      description: "Whether new attributes are described one by one in the builder or written as one SELECT.",
    }),
    param.valuerows("creates", "New attributes", {
      description:
        "One row per new attribute: its name and its value, which may be a constant, an attribute, a formula or SQL.",
      when: (node) => (node.params.mode ?? "Builder") === "Builder",
    }),
    param.sqlcreate("sql", "Query", {
      placeholder: "SELECT\n  input.*,\n  <expression> AS <new_column>\nFROM input",
      description: "A single DuckDB SELECT over the table input that keeps input.* and adds at least one new column.",
      when: (node) => node.params.mode === "SQL query",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    if (ctx.params.mode === "SQL query") {
      const statement = (ctx.params.sql || "").trim();
      if (!statement) return { output: `SELECT * FROM ${ctx.inputs.input}` };
      return { output: spliceQuery(statement, ctx.inputs.input) };
    }
    const additions = (ctx.params.creates || [])
      .filter((create) => create.name)
      .map((create) => ({ name: create.name, sql: valueSql(create.value) }))
      .filter((create) => create.sql);
    if (!additions.length) return { output: `SELECT * FROM ${ctx.inputs.input}` };
    const selection = additions.map((create) => `${create.sql} AS ${qid(create.name)}`).join(", ");
    return { output: `SELECT *, ${selection} FROM ${ctx.inputs.input}` };
  },
  // Enforced at compile time too: a graph can be opened from a file, and a node that adds nothing should say so.
  check: async (ctx) => {
    if (ctx.params.mode !== "SQL query") return;
    const verdict = await checkSql(ctx.params.sql, ctx.inputs.input, ctx.schemas?.input || [], {
      requireNewColumns: true,
    });
    if (!verdict.ok) throw new Error(verdict.message);
  },
});

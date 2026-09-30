// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, columnList } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeKeeper",
  group: "Attributes",
  summary: "Keeps only the listed attributes, in the order you list them.",
  description:
    "AttributeKeeper narrows a stream to the attributes you name and drops every other column. The " +
    "kept columns come out in the order you list them, which also makes it the simplest way to reorder " +
    "columns. The geometry column is an attribute like any other: list it to keep it, leave it out to drop " +
    "it. With nothing listed, every attribute passes through unchanged, so a half-configured node never " +
    "breaks the graph. It does not rename or change any values.",
  whenToUse: [
    "keep only the id and name columns before exporting",
    "reorder the columns of a table",
    "drop everything except the geometry",
  ],
  whenNotToUse: [
    "dropping just one or two columns from a wide table — AttributeRemover names only what goes",
    "renaming columns — use AttributeRenamer",
  ],
  keywords: ["keep", "select columns", "subset", "columns", "fields", "reorder", "project"],
  examples: [{ input: "id, name, cat, v, geometry", params: "Attributes to keep = name, id", output: "name, id" }],
  inputs: SINGLE_IN,
  outputs: [
    {
      id: "output",
      label: "Output",
      description: "The same rows, with only the listed attributes, in the listed order.",
    },
  ],
  params: [
    param.columns("columns", "Attributes to keep", {
      description: "The attributes to keep, in the order they should come out; every other attribute is dropped.",
    }),
  ],
  sql: (ctx) => {
    const kept = columnList(ctx.params.columns);
    return { output: `SELECT ${kept || "*"} FROM ${ctx.inputs.input}` };
  },
});

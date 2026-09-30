// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, columnList } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeRemover",
  group: "Attributes",
  summary: "Drops the listed attributes and keeps all the others, in their order.",
  description:
    "AttributeRemover takes the attributes you name out of the stream and passes every other column " +
    "through, in its original order. It is the counterpart of AttributeKeeper for the common case of a " +
    "wide table with a few unwanted columns, where naming what goes is shorter than naming what stays. The " +
    "geometry column can be removed like any other attribute, which turns a layer into a plain table. With " +
    "nothing listed it removes nothing. It does not change values or rows.",
  whenToUse: [
    "drop the internal columns before exporting",
    "remove the geometry to get a plain table",
    "tidy a wide table by taking out a few columns",
  ],
  whenNotToUse: ["keeping just a few columns of a wide table — AttributeKeeper names only what stays"],
  keywords: ["remove", "drop columns", "delete field", "exclude", "columns", "attributes"],
  examples: [
    { input: "id, name, cat, v, geometry", params: "Attributes to remove = cat, v", output: "id, name, geometry" },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows without the listed attributes." }],
  params: [
    param.columns("columns", "Attributes to remove", {
      description: "The attributes to drop from every row; all the other attributes are kept in their order.",
    }),
  ],
  sql: (ctx) => {
    const dropped = columnList(ctx.params.columns);
    return { output: `SELECT ${dropped ? `* EXCLUDE (${dropped})` : "*"} FROM ${ctx.inputs.input}` };
  },
});

// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid, qlit, MAX_FILTER_PORTS } from "../_kit/index.js";

function ports(params) {
  const values = (params.values || []).slice(0, MAX_FILTER_PORTS);
  // Addressed by position (v0, v1…), so a value with a quote or a slash never has to be a view name.
  const out = values.map((value, index) => ({
    id: `v${index}`,
    label: String(value),
    description: `Rows whose attribute equals "${value}".`,
  }));
  out.push({
    id: "unfiltered",
    label: "<Unfiltered>",
    description: "Rows matching none of the values, and rows where the attribute is NULL.",
  });
  return out;
}

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeFilter",
  group: "Filters",
  summary: "Routes rows to one output per value of an attribute, plus the rest.",
  description:
    "AttributeFilter looks at one attribute and gives each value you list its own output port; rows " +
    "with any other value, or with no value at all, come out of Unfiltered. The ports appear on the " +
    "canvas as you add values, so each category can be wired to its own branch. Values are compared " +
    "exactly, as text. At most forty values get ports, so pointing it at an id column cannot freeze the " +
    "canvas; anything past that falls through to Unfiltered. It does not test ranges or patterns — use " +
    "Tester or TestFilter for those.",
  whenToUse: [
    "send farms, mills and forests down separate branches",
    "split a layer by country code",
    "pick out two categories and keep the rest together",
  ],
  whenNotToUse: [
    "numeric ranges or patterns — use Tester or TestFilter",
    "counting the values of a column — use ListUniqueValues",
  ],
  keywords: ["filter", "split", "route", "category", "by value", "classify", "branch"],
  examples: [
    {
      input: "rows with cat a, b, c or NULL",
      params: "Attribute = cat, Values = a, b",
      output: "a → one port, b → another, c and NULL → Unfiltered",
    },
  ],
  inputs: SINGLE_IN,
  outputs: ports,
  params: [
    param.column("column", "Attribute", {
      description: "The attribute whose value decides which output port a row goes to.",
    }),
    param.values("values", "Values", {
      description: "The values that each get their own output port, compared exactly with the attribute as text.",
    }),
  ],
  sql: (ctx) => {
    const column = ctx.params.column;
    const input = ctx.inputs.input;
    const values = (ctx.params.values || []).slice(0, MAX_FILTER_PORTS);
    /** @type {Record<string, string>} */
    const out = {};
    values.forEach((value, index) => {
      out[`v${index}`] = column
        ? `SELECT * FROM ${input} WHERE ${qid(column)} = ${qlit(value)}`
        : `SELECT * FROM ${input} WHERE FALSE`;
    });
    if (!column) return { ...out, unfiltered: `SELECT * FROM ${input}` };
    const matched = values.map(qlit).join(", ");
    out.unfiltered = matched
      ? `SELECT * FROM ${input} WHERE ${qid(column)} IS NULL OR ${qid(column)} NOT IN (${matched})`
      : `SELECT * FROM ${input}`;
    return out;
  },
});

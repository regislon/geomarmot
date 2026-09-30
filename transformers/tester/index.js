// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, buildPredicate, truthy } from "../_kit/index.js";

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "Tester",
  group: "Filters",
  summary: "Splits rows into those that pass a set of conditions and those that fail.",
  description:
    "Tester checks every row against a list of conditions — equals, not equals, greater or less than, " +
    "contains, starts with, is null, is not null — combined with AND or OR, and sends each row out of " +
    "passed or failed. A row whose test cannot be decided (a NULL attribute) goes to failed rather than " +
    "vanishing, so the two ports always add up to the input. Values are compared as the column's type: " +
    "typing 5 against a number column compares numbers. The value field suggests what is actually in the " +
    "column. With no conditions, everything passes. It does not route rows to more than two outputs.",
  whenToUse: [
    "keep rows where population is over 50000",
    "split rows with a missing category from the rest",
    "find names that start with a prefix",
  ],
  whenNotToUse: [
    "one output per category value — use AttributeFilter",
    "several rules where the first match wins — use TestFilter",
    "a filter on area in hectares — use FilterVectorFeaturesByArea",
  ],
  keywords: ["filter", "where", "test", "condition", "select rows", "query", "extract by attribute"],
  examples: [{ input: "cities with pop", params: "pop > 50000", output: "passed: the big cities; failed: the rest" }],
  inputs: SINGLE_IN,
  outputs: [
    { id: "passed", label: "Passed", description: "Rows for which the combined conditions are true." },
    { id: "failed", label: "Failed", description: "Rows for which they are false or cannot be decided (NULL)." },
  ],
  params: [
    param.select("logic", "Combine with", {
      options: [
        { value: "AND", description: "A row passes when every condition holds." },
        { value: "OR", description: "A row passes when any condition holds." },
      ],
      default: "AND",
      description: "How the conditions combine into one test: all of them, or any of them.",
    }),
    param.conditions("conditions", "Conditions", {
      description: "Each condition is an attribute, an operator and, for most operators, a value to compare with.",
    }),
  ],
  sql: (ctx) => {
    const predicate = buildPredicate(ctx.params.conditions, ctx.params.logic);
    const input = ctx.inputs.input;
    if (!predicate) return { passed: `SELECT * FROM ${input}`, failed: `SELECT * FROM ${input} WHERE FALSE` };
    const test = truthy(predicate);
    return { passed: `SELECT * FROM ${input} WHERE ${test}`, failed: `SELECT * FROM ${input} WHERE NOT ${test}` };
  },
});

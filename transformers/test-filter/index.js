// @ts-check
import {
  defineTransformer,
  API_VERSION,
  param,
  SINGLE_IN,
  qid,
  OPERATORS,
  truthy,
  MAX_FILTER_PORTS,
} from "../_kit/index.js";

function ports(params) {
  const rules = (params.rules || []).slice(0, MAX_FILTER_PORTS);
  const out = rules.map((rule, index) => ({
    id: `r${index}`,
    label: rule.label || `Rule ${index + 1}`,
    description: "Rows that satisfy this rule and none of the rules above it.",
  }));
  out.push({ id: "unfiltered", label: "<Unfiltered>", description: "Rows that satisfy none of the rules." });
  return out;
}

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "TestFilter",
  group: "Filters",
  summary: "Routes each row to the first of several rules it satisfies, or to Unfiltered.",
  description:
    "TestFilter holds an ordered list of rules, each an attribute, an operator and a value, and each with " +
    "its own output port. Every row goes to the first rule it satisfies; a row that satisfied an earlier " +
    "rule is never offered to the later ones, so the ports partition the input rather than overlap. Rows " +
    "that satisfy no rule come out of Unfiltered. A rule that is not filled in matches nothing. This is how " +
    "you classify rows into bands — big, medium, small — in one node. It does not combine conditions " +
    "within a rule; use a Tester upstream for that.",
  whenToUse: [
    "classify values into bands in one node",
    "route rows by the first matching condition",
    "split by several prefixes in priority order",
  ],
  whenNotToUse: ["one port per exact value — use AttributeFilter", "a single pass/fail test — use Tester"],
  keywords: ["filter", "classify", "rules", "first match", "route", "bands", "case when"],
  examples: [
    {
      input: "rows with v",
      params: "big: v > 5, then a: cat = a",
      output: "big rows first, then the remaining a rows, the rest Unfiltered",
    },
  ],
  inputs: SINGLE_IN,
  outputs: ports,
  params: [
    param.rules("rules", "Rules, in order", {
      description: "Each rule has a label, an attribute, an operator and a value; the first rule a row satisfies wins.",
    }),
  ],
  sql: (ctx) => {
    const input = ctx.inputs.input;
    const rules = (ctx.params.rules || []).slice(0, MAX_FILTER_PORTS);
    /** @type {Record<string, string>} */
    const out = {};
    const earlier = [];
    rules.forEach((rule, index) => {
      const build = OPERATORS[rule.operator];
      const predicate = rule.column && build ? truthy(`(${build(qid(rule.column), rule.value ?? "")})`) : null;
      const unclaimed = earlier.length ? ` AND NOT (${earlier.join(" OR ")})` : "";
      out[`r${index}`] = predicate
        ? `SELECT * FROM ${input} WHERE ${predicate}${unclaimed}`
        : `SELECT * FROM ${input} WHERE FALSE`;
      if (predicate) earlier.push(predicate);
    });
    out.unfiltered = earlier.length
      ? `SELECT * FROM ${input} WHERE NOT (${earlier.join(" OR ")})`
      : `SELECT * FROM ${input}`;
    return out;
  },
});

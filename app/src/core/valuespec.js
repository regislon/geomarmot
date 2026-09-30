/*
 * "What should this attribute hold?", without writing SQL.
 *
 * Shared by AttributeCreator's builder and by AttributeManager's Set/Create
 * edits, because they are the same question asked in two places and answering
 * it differently in each would be a way to make them disagree.
 *
 * Every spec compiles to a SQL expression in the end — the builder is a way to
 * write one, not a different engine. The SQL kind is the escape hatch, so
 * nothing the builder cannot express becomes a reason to leave the node.
 */

import { qid, qlit } from "./duck.js";

export const VALUE_KINDS = ["Value", "Attribute", "Formula", "SQL"];

/**
 * The literal's type, chosen rather than guessed.
 *
 * Sniffing it from the text would read "01234" as the number 1234 and quietly
 * lose the leading zero — and a postcode column is exactly the sort of thing
 * someone types in here.
 */
export const VALUE_TYPES = ["Text", "Number", "Boolean", "Null"];

export const FORMULA_OPERATORS = ["+", "-", "×", "÷", "join text"];

const OPERATOR_SQL = {
  "+": (left, right) => `${left} + ${right}`,
  "-": (left, right) => `${left} - ${right}`,
  "×": (left, right) => `${left} * ${right}`,
  // NULLIF guards the one case that turns a whole column into an error rather
  // than a gap; division by zero is a missing answer, not a crash.
  "÷": (left, right) => `${left} / NULLIF(${right}, 0)`,
  "join text": (left, right) => `${left} || ${right}`,
};

/** A typed literal, as SQL. */
function literalSql(text, type) {
  const raw = text ?? "";
  switch (type) {
    case "Number": {
      const number = Number(raw);
      if (raw === "" || !Number.isFinite(number)) return null;
      return String(number);
    }
    case "Boolean":
      return /^(true|yes|1)$/i.test(String(raw).trim()) ? "TRUE" : "FALSE";
    case "Null":
      return "NULL";
    default:
      return qlit(String(raw));
  }
}

/** One side of a formula: a column, or a typed literal. */
function operandSql(operand) {
  if (!operand) return null;
  if (operand.kind === "Attribute") return operand.column ? qid(operand.column) : null;
  return literalSql(operand.value, operand.type || "Number");
}

/**
 * A spec as SQL, or null when it is not filled in yet.
 *
 * Null rather than a throw: a row half-typed is the normal state of a row being
 * typed, and it should be skipped rather than break the graph on every
 * keystroke.
 */
export function valueSql(spec) {
  if (!spec) return null;
  switch (spec.kind || "Value") {
    case "Attribute":
      return spec.column ? qid(spec.column) : null;
    case "Formula": {
      const left = operandSql(spec.left);
      const right = operandSql(spec.right);
      const build = OPERATOR_SQL[spec.operator || "+"];
      return left && right && build ? `(${build(left, right)})` : null;
    }
    case "SQL":
      return spec.sql?.trim() ? `(${spec.sql.trim()})` : null;
    default:
      return literalSql(spec.value, spec.type || "Text");
  }
}

/** A blank spec, so a new row starts somewhere sensible. */
export function blankValue() {
  return {
    kind: "Value",
    type: "Text",
    value: "",
    column: "",
    operator: "+",
    left: { kind: "Attribute", column: "", type: "Number", value: "" },
    right: { kind: "Value", column: "", type: "Number", value: "" },
    sql: "",
  };
}

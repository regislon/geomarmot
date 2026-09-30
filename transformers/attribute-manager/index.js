// @ts-check
import { defineTransformer, API_VERSION, param, SINGLE_IN, qid, valueSql, spliceExpression } from "../_kit/index.js";

/** An edit's value, from its value spec, or from the older raw-SQL `value` field. */
function editValueSql(action) {
  if (action.spec) return valueSql(action.spec);
  return typeof action.value === "string" && action.value.trim() ? spliceExpression(action.value.trim()) : null;
}

/**
 * One edit as a SELECT list plus the columns it leaves behind, or null for a
 * row that is not filled in yet (skipped rather than compiled into broken SQL).
 */
function attributeEdit(action, columns) {
  const has = (name) => columns.includes(name);
  switch (action.action) {
    case "Set value": {
      const value = editValueSql(action);
      if (!action.column || !has(action.column) || !value) return null;
      return { selection: `* REPLACE ((${value}) AS ${qid(action.column)})`, columns };
    }
    case "Rename":
      if (!action.column || !has(action.column) || !action.target) return null;
      // `* RENAME` is a parser error on this DuckDB, so exclude and re-add.
      return {
        selection: `* EXCLUDE (${qid(action.column)}), ${qid(action.column)} AS ${qid(action.target)}`,
        columns: columns.map((name) => (name === action.column ? action.target : name)),
      };
    case "Copy to":
      if (!action.column || !has(action.column) || !action.target) return null;
      return { selection: `*, ${qid(action.column)} AS ${qid(action.target)}`, columns: [...columns, action.target] };
    case "Create": {
      const value = editValueSql(action);
      if (!action.target || !value) return null;
      return { selection: `*, (${value}) AS ${qid(action.target)}`, columns: [...columns, action.target] };
    }
    case "Remove":
      if (!action.column || !has(action.column)) return null;
      return {
        selection: `* EXCLUDE (${qid(action.column)})`,
        columns: columns.filter((name) => name !== action.column),
      };
    default:
      return null;
  }
}

export default defineTransformer({
  apiVersion: API_VERSION,
  id: "AttributeManager",
  group: "Attributes",
  summary: "Sets, renames, copies, creates and removes attributes — in order, in one node.",
  description:
    "AttributeManager applies a list of attribute edits in order: Set value overwrites an attribute, " +
    "Rename changes its name, Copy to duplicates it under a new name, Create adds a new one, and Remove " +
    "drops it. Order matters and is kept — renaming a column and then setting the new name's value differs " +
    "from the reverse — so each edit is its own nested SELECT. Values use the same builder as " +
    "AttributeCreator: a constant, an attribute, a formula or SQL. An edit that is not filled in, or that " +
    "names an attribute that is not there, is skipped. It does not filter or reorder rows.",
  whenToUse: [
    "make a dozen small attribute edits in one step instead of a dozen nodes",
    "rename a column and then set its values",
    "copy an attribute before overwriting it",
  ],
  whenNotToUse: [
    "one kind of edit on a few columns — AttributeKeeper, AttributeRemover or AttributeRenamer read better on the canvas",
    "adding computed columns with a full SELECT — use AttributeCreator's SQL mode",
  ],
  keywords: ["edit attributes", "modify fields", "set value", "rename", "copy", "remove", "attribute manager"],
  examples: [
    {
      input: "id, name, v",
      params: "Rename v → w, then Set value w = id × 100",
      output: "id, name, w with w = id × 100",
    },
  ],
  inputs: SINGLE_IN,
  outputs: [{ id: "output", label: "Output", description: "The same rows after every edit, applied in order." }],
  params: [
    param.actions("actions", "Edits", {
      description: "The edits to apply, top to bottom; each one sees the attributes as the edits above it left them.",
    }),
  ],
  needs: { schema: true },
  sql: (ctx) => {
    let columns = (ctx.schemas?.input || []).map((column) => column.name);
    let relation = ctx.inputs.input;
    for (const action of ctx.params.actions || []) {
      const step = attributeEdit(action, columns);
      if (!step) continue;
      relation = `(SELECT ${step.selection} FROM ${relation})`;
      columns = step.columns;
    }
    return { output: `SELECT * FROM ${relation}` };
  },
});

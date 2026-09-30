/* The value-spec editor: a constant, an attribute, a formula or SQL. */

import { FORMULA_OPERATORS, VALUE_KINDS, VALUE_TYPES } from "../../core/valuespec.js";
import { columnNames, h, select, textInput } from "./widgets.js";

/**
 * The "what should this hold?" editor, shared by both nodes that ask.
 *
 * Returns the fields for one spec, laid out as a wrapping group rather than a
 * single line: four controls do not fit across a narrow inspector, and a row
 * that overflows is worse than one that wraps.
 */
export function renderValueSpec(spec, columns, commit) {
  const group = h("div", { class: "value-spec" });
  const set = (key, value, rerender) => {
    spec[key] = value;
    commit(rerender ? {} : { rerender: false });
  };

  group.appendChild(select(VALUE_KINDS, spec.kind || "Value", (value) => set("kind", value, true)));

  if ((spec.kind || "Value") === "Value") {
    group.appendChild(select(VALUE_TYPES, spec.type || "Text", (value) => set("type", value, true)));
    if ((spec.type || "Text") !== "Null") {
      group.appendChild(textInput(spec.value, (value) => set("value", value), "value"));
    }
  } else if (spec.kind === "Attribute") {
    group.appendChild(select(columnNames(columns), spec.column, (value) => set("column", value)));
  } else if (spec.kind === "Formula") {
    const operand = (side) => {
      const part = spec[side] || (spec[side] = { kind: "Attribute", type: "Number", value: "", column: "" });
      const box = h("span", { class: "operand" });
      box.appendChild(
        select(["Attribute", "Value"], part.kind || "Attribute", (value) => {
          part.kind = value;
          commit();
        }),
      );
      if ((part.kind || "Attribute") === "Attribute") {
        box.appendChild(
          select(columnNames(columns), part.column, (value) => {
            part.column = value;
            commit({ rerender: false });
          }),
        );
      } else {
        box.appendChild(
          textInput(
            part.value,
            (value) => {
              part.value = value;
              commit({ rerender: false });
            },
            "value",
          ),
        );
      }
      return box;
    };
    group.appendChild(operand("left"));
    group.appendChild(select(FORMULA_OPERATORS, spec.operator || "+", (value) => set("operator", value)));
    group.appendChild(operand("right"));
  } else {
    group.appendChild(textInput(spec.sql, (value) => set("sql", value), "SQL expression"));
  }
  return group;
}

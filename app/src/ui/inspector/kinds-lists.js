/*
 * Editors for the list-shaped parameter kinds: columns, conditions, renames,
 * value rows, choices, actions, creates, sorts, aggregates, rules, join keys.
 */

import { AGGREGATE_FUNCTIONS, OPERATORS } from "../../../../transformers/legacy.js";
import { blankValue } from "../../core/valuespec.js";
import { renderValueSpec } from "./kinds-value.js";
import {
  NUMERIC_TYPE,
  columnNames,
  h,
  repeatable,
  select,
  selectAllToggle,
  suggestingInput,
  textInput,
} from "./widgets.js";

export function renderColumnsParam(param, node, columns, commit) {
  // `filter: "numeric"` keeps sum and mean away from a text column, where they
  // would compile into SQL that only fails once the node runs.
  const offered = param.filter === "numeric" ? columns.filter((column) => NUMERIC_TYPE.test(column.type)) : columns;
  const names = columnNames(offered);
  const chosen = new Set(node.params[param.id] || []);
  const list = h("div", { class: "check-list" });
  if (!offered.length) {
    list.appendChild(h("p", { class: "muted", text: "No numeric attributes on this input." }));
  }

  const apply = () => {
    // Preserve the upstream column order rather than click order, so the
    // exported file's columns come out in the order the user sees them.
    node.params[param.id] = names.filter((column) => chosen.has(column));
    commit({ rerender: false });
  };

  const boxes = new Map();
  for (const name of names) {
    const box = h("input", { type: "checkbox" });
    box.checked = chosen.has(name);
    boxes.set(name, box);
    list.appendChild(h("label", { class: "check" }, [box, h("span", { text: name })]));
  }

  // A single column needs no master switch — it would be the longer click.
  const toggle = names.length > 1 ? selectAllToggle(names, chosen, boxes, apply) : null;

  for (const [name, box] of boxes) {
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(name);
      else chosen.delete(name);
      toggle?.sync();
      apply();
    });
  }

  if (!toggle) return list;
  return h("div", { class: "check-group" }, [toggle.row, list]);
}

export function renderConditionsParam(param, node, context, commit) {
  const columns = context.columns;
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => [
      select(columnNames(columns), row.column, (value) => {
        row.column = value;
        // Re-render: the suggestions belong to the column just chosen.
        commit();
      }),
      select(Object.keys(OPERATORS), row.operator, (value) => {
        row.operator = value;
        commit();
      }),
      // "is null" takes no operand; showing a dead input would invite people to
      // type into it and wonder why nothing changed.
      row.operator && row.operator.startsWith("is ")
        ? h("span", { class: "muted", text: "" })
        : suggestingInput(
            row.value,
            (value) => {
              row.value = value;
              commit({ rerender: false });
            },
            "value",
            context,
            row.column,
          ),
    ],
    () => ({ column: "", operator: "=", value: "" }),
    commit,
  );
}

export function renderRenamesParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => [
      select(columnNames(columns), row.from, (value) => {
        row.from = value;
        commit({ rerender: false });
      }),
      h("span", { class: "arrow", text: "→" }),
      textInput(
        row.to,
        (value) => {
          row.to = value;
          commit({ rerender: false });
        },
        "new name",
      ),
    ],
    () => ({ from: "", to: "" }),
    commit,
  );
}

/** AttributeCreator's builder: a name and a value, per new attribute. */
export function renderValueRowsParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => {
      if (!row.value) row.value = blankValue();
      return [
        textInput(
          row.name,
          (value) => {
            row.name = value;
            commit({ rerender: false });
          },
          "new attribute",
        ),
        h("span", { class: "arrow", text: "=" }),
        renderValueSpec(row.value, columns, commit),
      ];
    },
    () => ({ name: "", value: blankValue() }),
    commit,
  );
}

/** A fixed set of checkboxes — for choices that are not columns. */
export function renderChoicesParam(param, node, commit) {
  const chosen = node.params[param.id] || (node.params[param.id] = [...(param.default || [])]);
  const container = h("div", { class: "choice-list" });
  for (const choice of param.choices || []) {
    const id = typeof choice === "string" ? choice : choice.value;
    const label = typeof choice === "string" ? choice : choice.label;
    const box = h("label", { class: "choice" });
    const input = h("input", { type: "checkbox" });
    input.checked = chosen.includes(id);
    input.addEventListener("change", () => {
      const next = input.checked ? [...chosen, id] : chosen.filter((value) => value !== id);
      // Kept in the declared order rather than click order, so the generated
      // column names come out the same whatever sequence they were ticked in.
      node.params[param.id] = (param.choices || [])
        .map((candidate) => (typeof candidate === "string" ? candidate : candidate.value))
        .filter((candidate) => next.includes(candidate));
      commit();
    });
    box.appendChild(input);
    box.appendChild(h("span", { text: label }));
    container.appendChild(box);
  }
  return container;
}

/**
 * The AttributeManager's edit list: an action per row, applied in order.
 *
 * Order is the whole point — renaming a column and then setting the new name's
 * value is a different result from doing it the other way round — so the rows
 * stay a list rather than becoming a set of independent settings.
 */
export function renderActionsParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  const ACTIONS = ["Set value", "Rename", "Copy to", "Create", "Remove"];
  return repeatable(
    rows,
    (row) => {
      const fields = [
        select(ACTIONS, row.action || "Set value", (value) => {
          row.action = value;
          commit();
        }),
      ];
      // "Create" invents a column, so it has no existing one to point at.
      if (row.action !== "Create") {
        fields.push(
          select(columnNames(columns), row.column, (value) => {
            row.column = value;
            commit({ rerender: false });
          }),
        );
      }
      if (row.action === "Rename" || row.action === "Copy to" || row.action === "Create") {
        fields.push(
          textInput(
            row.target,
            (value) => {
              row.target = value;
              commit({ rerender: false });
            },
            "new name",
          ),
        );
      }
      if (row.action === "Set value" || row.action === "Create") {
        // The same editor AttributeCreator's builder uses: a constant, another
        // attribute, a small formula, or SQL when none of those reach.
        if (!row.spec) row.spec = blankValue();
        fields.push(renderValueSpec(row.spec, columns, commit));
      }
      return fields;
    },
    () => ({ action: "Set value", column: "", target: "", value: "" }),
    commit,
  );
}

export function renderCreatesParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => [
      textInput(
        row.name,
        (value) => {
          row.name = value;
          commit({ rerender: false });
        },
        "attribute",
      ),
      h("span", { class: "arrow", text: "=" }),
      textInput(
        row.expression,
        (value) => {
          row.expression = value;
          commit({ rerender: false });
        },
        "SQL expression",
      ),
    ],
    () => ({ name: "", expression: "" }),
    commit,
  );
}

export function renderSortsParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => [
      select(columnNames(columns), row.column, (value) => {
        row.column = value;
        commit({ rerender: false });
      }),
      select(["ASC", "DESC"], row.direction || "ASC", (value) => {
        row.direction = value;
        commit({ rerender: false });
      }),
    ],
    () => ({ column: "", direction: "ASC" }),
    commit,
  );
}

export function renderAggregatesParam(param, node, columns, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row) => [
      select(AGGREGATE_FUNCTIONS, row.func, (value) => {
        row.func = value;
        commit({ rerender: false });
      }),
      select(columnNames(columns), row.column, (value) => {
        row.column = value;
        commit({ rerender: false });
      }),
      textInput(
        row.alias,
        (value) => {
          row.alias = value;
          commit({ rerender: false });
        },
        "as…",
      ),
    ],
    () => ({ func: "count", column: "", alias: "" }),
    commit,
  );
}

export function renderRulesParam(param, node, context, commit) {
  const columns = context.columns;
  const rows = node.params[param.id] || (node.params[param.id] = []);
  return repeatable(
    rows,
    (row, index) => [
      textInput(
        row.label,
        (value) => {
          row.label = value;
          commit();
        },
        `Rule ${index + 1}`,
      ),
      select(columnNames(columns), row.column, (value) => {
        row.column = value;
        // Re-render: the suggestions belong to the column just chosen.
        commit();
      }),
      select(Object.keys(OPERATORS), row.operator, (value) => {
        row.operator = value;
        commit();
      }),
      row.operator && row.operator.startsWith("is ")
        ? h("span", { class: "muted", text: "" })
        : suggestingInput(
            row.value,
            (value) => {
              row.value = value;
              commit({ rerender: false });
            },
            "value",
            context,
            row.column,
          ),
    ],
    () => ({ label: "", column: "", operator: "=", value: "" }),
    commit,
  );
}

/** Pairs of columns, one from each input, for a join. */
export function renderJoinKeysParam(param, node, context, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  const left = columnNames(context.columnsByPort?.left || []);
  const right = columnNames(context.columnsByPort?.right || []);
  const container = h("div");
  container.appendChild(
    repeatable(
      rows,
      (row) => [
        select(left, row.left, (value) => {
          row.left = value;
          commit({ rerender: false });
        }),
        h("span", { class: "arrow", text: "=" }),
        select(right, row.right, (value) => {
          row.right = value;
          commit({ rerender: false });
        }),
      ],
      () => ({ left: "", right: "" }),
      commit,
    ),
  );
  if (!left.length || !right.length) {
    container.appendChild(h("p", { class: "muted", text: "Connect both inputs to choose attributes." }));
  }
  return container;
}

/*
 * AttributeManager's editor: every attribute in one table, in a window.
 *
 * Input attribute | Output attribute | Value | Type | Action, one row per input
 * attribute (doing nothing until told otherwise), then the rows that copy or
 * create one. Typing an output name renames; giving a value sets it. Nothing
 * reaches the node until OK, so Cancel really is cancel.
 */

import { blankValue } from "../../core/valuespec.js";
import { duplicateOutputs, rowAction, toActions, toRows } from "./attribute-table-model.js";
import { renderValueSpec } from "./kinds-value.js";
import { h, select } from "./widgets.js";

const INPUT_ACTIONS = ["Do nothing", "Rename", "Set value", "Rename and set value", "Remove"];
const NEW = "(new attribute)";

let modal = null;

function frame() {
  if (modal) return modal;
  modal = h("div", { class: "modal attribute-table-modal", hidden: "" });
  document.body.appendChild(modal);
  // The backdrop cancels; the panel must not.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  return modal;
}

/**
 * @param {{ node: any, param: any, columns: Array<{ name: string, type?: string }>, commit: Function, title?: string }} options
 */
export function openAttributeTable({ node, param, columns, commit, title = "AttributeManager" }) {
  const { rows, exact } = toRows(node.params[param.id] || [], columns);
  const names = columns.map((column) => column.name);
  const root = frame();
  const body = h("tbody");
  const problem = h("p", { class: "attribute-table-problem", hidden: "" });
  const filter = h("input", {
    type: "search",
    class: "attribute-table-filter",
    placeholder: "Find an attribute",
    "aria-label": "Find an attribute",
  });

  const shown = (row) => {
    const needle = filter.value.trim().toLowerCase();
    return !needle || [row.input, row.output].some((name) => name && name.toLowerCase().includes(needle));
  };

  const renderRow = (row) => {
    const tr = h("tr", { class: `attribute-row action-${rowAction(row).toLowerCase().replace(/ /g, "-")}` });
    const redraw = () => {
      const fresh = renderRow(row);
      tr.replaceWith(fresh);
      markDuplicates();
      return fresh;
    };
    tr.hidden = !shown(row);

    // Input attribute: fixed for the input's own rows; chosen for an added row (copy one, or a new one).
    const input = row.added
      ? select([NEW, ...names], row.input || NEW, (value) => {
          row.input = value === NEW ? null : value;
          row.spec = row.input ? null : row.spec || blankValue();
          if (row.input && !row.output) row.output = `${row.input}_copy`;
          redraw();
        })
      : h("span", { class: "attribute-input", text: row.input, title: row.input });

    const output = h("input", {
      type: "text",
      class: "attribute-output",
      value: row.output,
      placeholder: row.added ? "new attribute name" : "",
      disabled: row.remove ? "" : undefined,
      "aria-label": `Output name for ${row.input || "the new attribute"}`,
    });
    output.value = row.output;
    output.addEventListener("input", () => {
      row.output = output.value;
      action.replaceWith((action = actionCell()));
      tr.className = `attribute-row action-${rowAction(row).toLowerCase().replace(/ /g, "-")}`;
      markDuplicates();
    });

    let value;
    if (row.remove || (row.added && row.input)) {
      value = h("span", { class: "muted", text: "" });
    } else if (row.spec) {
      const editor = renderValueSpec(row.spec, columns, (options = {}) => {
        if (options.rerender !== false) redraw();
      });
      const clear = row.added
        ? null
        : h("button", {
            class: "icon-btn attribute-clear",
            text: "×",
            title: "Keep the input's value",
            onclick: () => {
              row.spec = null;
              redraw();
            },
          });
      value = h("div", { class: "attribute-value" }, clear ? [editor, clear] : [editor]);
    } else {
      value = h("button", {
        class: "link-btn",
        text: "set a value",
        onclick: () => {
          row.spec = blankValue();
          redraw();
        },
      });
    }

    const type = h("span", { class: "attribute-type", text: row.type || "" });

    const actionCell = () => {
      if (row.added) {
        return h("span", { class: "attribute-action" }, [
          h("span", { text: rowAction(row) }),
          h("button", {
            class: "icon-btn",
            text: "×",
            title: "Remove this row",
            "aria-label": "Remove this row",
            onclick: () => {
              rows.splice(rows.indexOf(row), 1);
              tr.remove();
              markDuplicates();
            },
          }),
        ]);
      }
      return select(INPUT_ACTIONS, rowAction(row), (choice) => {
        row.remove = choice === "Remove";
        if (choice === "Do nothing" || choice === "Set value" || choice === "Remove") row.output = row.input;
        if (choice === "Do nothing" || choice === "Rename" || choice === "Remove") row.spec = null;
        if (/set value/i.test(choice)) row.spec ||= blankValue();
        const fresh = redraw();
        if (choice.startsWith("Rename")) fresh.querySelector(".attribute-output")?.focus();
      });
    };
    let action = actionCell();

    tr.append(
      h("td", {}, [input]),
      h("td", {}, [output]),
      h("td", {}, [value]),
      h("td", {}, [type]),
      h("td", {}, [action]),
    );
    return tr;
  };

  const markDuplicates = () => {
    const twice = duplicateOutputs(rows);
    body.querySelectorAll(".attribute-output").forEach((field, index) => {
      const row = rows[index];
      const clash = Boolean(row && !row.remove && twice.has(row.output.trim().toLowerCase()));
      field.classList.toggle("clash", clash);
      field.title = clash ? "Another attribute already has this name" : "";
    });
  };

  const draw = () => {
    body.replaceChildren(...rows.map(renderRow));
    markDuplicates();
  };
  filter.addEventListener("input", () => {
    [...body.children].forEach((tr, index) => (tr.hidden = !shown(rows[index])));
  });

  const close = () => (root.hidden = true);
  const ok = () => {
    if (duplicateOutputs(rows).size) {
      problem.textContent = "Two attributes would have the same name; rename one of them first.";
      problem.hidden = false;
      return;
    }
    if (rows.some((row) => row.added && !row.output.trim())) {
      problem.textContent = "A new attribute needs a name.";
      problem.hidden = false;
      return;
    }
    node.params[param.id] = toActions(rows);
    close();
    commit();
  };
  const add = () => {
    rows.push({ input: null, output: "", spec: blankValue(), remove: false, added: true, type: "" });
    body.appendChild(renderRow(rows.at(-1)));
    body.lastElementChild?.querySelector(".attribute-output")?.focus();
  };

  const changed = rows.filter((row) => rowAction(row) !== "Do nothing").length;
  root.replaceChildren(
    h("div", { class: "modal-panel attribute-table-panel", role: "dialog", "aria-label": `${title} attributes` }, [
      h("div", { class: "modal-head" }, [
        h("h2", { text: `${title} — attributes` }),
        h("button", { class: "icon-btn", text: "×", title: "Cancel", onclick: close }),
      ]),
      h("div", { class: "attribute-table-tools" }, [
        filter,
        h("span", { class: "muted", text: `${names.length} input attributes · ${changed} changed` }),
      ]),
      ...(exact
        ? []
        : [
            h("p", {
              class: "attribute-table-warning",
              text: "These edits were written in an order the table cannot show exactly. OK rewrites them in table order: copies, values, new attributes, renames, then removals; values read the input's attribute names.",
            }),
          ]),
      h("div", { class: "attribute-table-scroll" }, [
        h("table", { class: "attribute-table" }, [
          h("thead", {}, [
            h(
              "tr",
              {},
              ["Input attribute", "Output attribute", "Value", "Type", "Action"].map((text) => h("th", { text })),
            ),
          ]),
          body,
        ]),
      ]),
      problem,
      h("div", { class: "attribute-table-foot" }, [
        h("button", { text: "+ Add attribute", onclick: add }),
        h("span", { class: "spacer" }),
        h("button", { text: "Cancel", onclick: close }),
        h("button", { class: "primary", text: "OK", onclick: ok }),
      ]),
    ]),
  );
  root.onkeydown = (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) close();
  };
  draw();
  root.hidden = false;
  filter.focus();
}

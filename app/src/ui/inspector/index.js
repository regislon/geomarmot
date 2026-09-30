/*
 * The parameter editor for the selected node.
 *
 * Every field is driven by the transformer's own `params` declaration, so a new
 * transformer gets an editor for free. Column pickers are populated from the
 * upstream view's real schema rather than from free text — mistyping a column
 * name is the most common way to break a chain, and it should not be possible
 * here.
 */

import { transformerFor } from "../../../../transformers/legacy.js";
import { isLonLatCode } from "../../core/schema.js";
import { blankValue } from "../../core/valuespec.js";
import {
  renderActionsParam,
  renderAggregatesParam,
  renderChoicesParam,
  renderColumnsParam,
  renderConditionsParam,
  renderCreatesParam,
  renderJoinKeysParam,
  renderRenamesParam,
  renderRulesParam,
  renderSortsParam,
  renderValueRowsParam,
} from "./kinds-lists.js";
import { renderSqlCreateParam, renderSqlTextParam, renderValuesParam } from "./kinds-sql.js";
import { renderValueSpec } from "./kinds-value.js";
import { clearStaleSuggestionLists, columnNames, h, select, textInput } from "./widgets.js";

const PARAM_RENDERERS = {
  // One value — a constant, an attribute, a formula or SQL — for parameters
  // that can be set either way, like VertexCreator's X/Y/Z. Numbers by default,
  // since that is what such a parameter almost always holds.
  valuespec: (param, node, context, commit) => {
    if (!node.params[param.id]) node.params[param.id] = { ...blankValue(), type: "Number" };
    return renderValueSpec(node.params[param.id], context.columns, commit);
  },
  columns: (param, node, context, commit) => renderColumnsParam(param, node, context.columns, commit),
  column: (param, node, context, commit) =>
    select(columnNames(context.columns), node.params[param.id], (value) => {
      node.params[param.id] = value;
      commit();
    }),
  select: (param, node, context, commit) =>
    // Options may be a function of the node, for choices that depend on
    // another parameter.
    select(
      typeof param.options === "function" ? param.options(node, context) : param.options || [],
      node.params[param.id] ?? param.default,
      (value) => {
        node.params[param.id] = value;
        commit();
      },
    ),
  string: (param, node, context, commit) =>
    textInput(
      node.params[param.id],
      (value) => {
        node.params[param.id] = value;
        commit({ rerender: false });
      },
      param.placeholder || "",
    ),
  source: (param, node, context, commit) =>
    select(
      [...context.sources.values()].map((source) => ({ value: source.id, label: source.name })),
      node.params[param.id],
      (value) => {
        node.params[param.id] = value;
        commit();
      },
      "Choose a file…",
    ),
  conditions: (param, node, context, commit) => renderConditionsParam(param, node, context, commit),
  renames: (param, node, context, commit) => renderRenamesParam(param, node, context.columns, commit),
  creates: (param, node, context, commit) => renderCreatesParam(param, node, context.columns, commit),
  sorts: (param, node, context, commit) => renderSortsParam(param, node, context.columns, commit),
  aggregates: (param, node, context, commit) => renderAggregatesParam(param, node, context.columns, commit),
  values: (param, node, context, commit) => renderValuesParam(param, node, context, commit),
  rules: (param, node, context, commit) => renderRulesParam(param, node, context, commit),
  joinkeys: (param, node, context, commit) => renderJoinKeysParam(param, node, context, commit),
  choices: (param, node, context, commit) => renderChoicesParam(param, node, commit),
  valuerows: (param, node, context, commit) => renderValueRowsParam(param, node, context.columns, commit),
  actions: (param, node, context, commit) => renderActionsParam(param, node, context.columns, commit),
  sqltext: (param, node, context, commit) => renderSqlTextParam(param, node, commit),
  sqlcreate: (param, node, context, commit) => renderSqlCreateParam(param, node, context, commit),
};

/**
 * Draw the editor for one node.
 *
 * `context` carries the upstream schema ({columns}), the source registry, the
 * upstream view name, and a `commit` callback the app uses to recompile.
 */
/**
 * Where the caret was, so a re-render does not throw it away.
 *
 * The inspector is rebuilt whenever the graph recompiles, which happens 220 ms
 * after you stop typing — so without this the field you are editing is
 * destroyed mid-sentence, focus falls back to the body, and the next Backspace
 * is read as "delete the selected node" instead of "delete a character".
 *
 * Fields are matched by position: the rebuild produces the same structure for
 * the same node, so the nth input before is the nth input after.
 */
function captureFocus(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const fields = [...container.querySelectorAll("input, select, textarea")];
  const index = fields.indexOf(active);
  if (index < 0) return null;
  const canSelect = typeof active.selectionStart === "number";
  return { index, start: canSelect ? active.selectionStart : null, end: canSelect ? active.selectionEnd : null };
}

function restoreFocus(container, snapshot) {
  if (!snapshot) return;
  const field = [...container.querySelectorAll("input, select, textarea")][snapshot.index];
  if (!field) return;
  field.focus({ preventScroll: true });
  if (snapshot.start !== null && typeof field.setSelectionRange === "function") {
    try {
      field.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // Some input types refuse a selection range; focus alone is enough.
    }
  }
}

export function renderInspector(container, node, context) {
  const focused = captureFocus(container);
  clearStaleSuggestionLists();
  container.replaceChildren();
  if (!node) {
    container.appendChild(h("p", { class: "muted", text: "Select a node to edit it." }));
    return;
  }

  const transformer = transformerFor(node.type);
  const heading = h("div", { class: "inspector-head" }, [h("h3", { text: node.type })]);
  if (transformer.help && context.onHelp) {
    const ask = h("button", { class: "help-btn", text: "?", title: `About ${node.type}` });
    ask.addEventListener("click", () => context.onHelp(transformer.help));
    heading.appendChild(ask);
  }
  container.appendChild(heading);
  if (transformer.hint) container.appendChild(h("p", { class: "muted", text: transformer.hint }));
  /*
   * Only shown when it is not lon/lat. The whole graph is lon/lat by default,
   * so saying so on every node would be noise — but once a Reprojector
   * has moved the stream, every node below it is somewhere the map, the
   * measurements and the export all have to work around, and that is worth a
   * line the user cannot miss.
   */
  if (context.crs && !isLonLatCode(context.crs)) {
    container.appendChild(h("p", { class: "crs-note", text: `Coordinates here are ${context.crs}` }));
  }

  for (const param of transformer.params) {
    // A `when` lets one node offer two ways of saying the same thing without
    // showing both at once — the builder or the query, not a panel of each.
    if (param.when && !param.when(node)) continue;
    const renderer = PARAM_RENDERERS[param.kind];
    if (!renderer) continue;
    const field = h("div", { class: "field" });
    field.appendChild(h("label", { class: "field-label", text: param.label }));
    field.appendChild(renderer(param, node, context, context.commit));
    container.appendChild(field);
  }

  if (transformer.action) {
    const button = h("button", {
      class: "primary action-btn",
      text: transformer.action.label,
      onclick: () => context.onAction?.(node, transformer.action.id),
    });
    button.disabled = !context.actionReady;
    container.appendChild(button);
  }

  if (context.issues?.length) {
    const list = h("ul", { class: "issues" });
    for (const issue of context.issues) list.appendChild(h("li", { text: issue.message }));
    container.appendChild(list);
  }

  restoreFocus(container, focused);
}

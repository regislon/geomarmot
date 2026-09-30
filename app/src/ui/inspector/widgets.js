/*
 * Building blocks of the parameter editor: elements, selects, text inputs with
 * value suggestions, repeatable rows and select-all toggles.
 */

import { valueSuggestions } from "../../core/schema.js";

export const DISTINCT_VALUE_LIMIT = 50;

export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) node.appendChild(child);
  return node;
}

export function select(options, value, onChange, placeholder = "—") {
  const node = h("select", { onchange: (event) => onChange(event.target.value) });
  node.appendChild(h("option", { value: "", text: placeholder }));
  for (const option of options) {
    const label = typeof option === "string" ? option : option.label;
    const optionValue = typeof option === "string" ? option : option.value;
    const element = h("option", { value: optionValue, text: label });
    if (String(optionValue) === String(value ?? "")) element.selected = true;
    node.appendChild(element);
  }
  return node;
}

export function textInput(value, onChange, placeholder = "") {
  return h("input", {
    type: "text",
    value: value ?? "",
    placeholder,
    oninput: (event) => onChange(event.target.value),
  });
}

/*
 * Value suggestions for condition inputs.
 *
 * A datalist rather than a dropdown: a Tester value is often something not in
 * the data at all — a threshold, a prefix for `starts with` — so the field has
 * to stay free text. Suggestions help without getting in the way.
 *
 * Results are cached per view and column because the inspector re-renders on
 * every keystroke, and re-running a DISTINCT for each one would be absurd.
 */
const suggestionCache = new Map();
let suggestionSeq = 0;

export function clearStaleSuggestionLists() {
  document.querySelectorAll("datalist[data-pv-suggest]").forEach((list) => list.remove());
}

export function suggestingInput(value, onChange, placeholder, context, column) {
  const input = textInput(value, onChange, placeholder);
  const columnType = context.columns?.find((entry) => entry.name === column)?.type;
  const view = context.upstreamView;
  if (!column || !view) return input;

  const listId = `pv-suggest-${(suggestionSeq += 1)}`;
  const list = document.createElement("datalist");
  list.id = listId;
  list.setAttribute("data-pv-suggest", "");
  // Parked on the body: a datalist has to be in the document to be found by
  // `list`, and the row it belongs to is not attached yet at this point.
  document.body.appendChild(list);
  input.setAttribute("list", listId);

  const key = `${view}::${column}`;
  const fill = (values) => {
    list.replaceChildren();
    for (const suggestion of values) {
      const option = document.createElement("option");
      option.value = suggestion;
      list.appendChild(option);
    }
  };
  if (suggestionCache.has(key)) {
    fill(suggestionCache.get(key));
  } else {
    valueSuggestions(view, column, columnType)
      .then((values) => {
        suggestionCache.set(key, values);
        fill(values);
      })
      .catch((err) => console.warn(`No suggestions for ${column}`, err));
  }
  return input;
}

/** A list of editable rows with add/remove, used by most compound parameters. */
export function repeatable(rows, renderRow, blank, commit) {
  const container = h("div", { class: "repeat" });
  rows.forEach((row, index) => {
    const line = h("div", { class: "repeat-row" });
    for (const field of renderRow(row, index)) line.appendChild(field);
    line.appendChild(
      h("button", {
        class: "icon-btn",
        title: "Remove",
        text: "×",
        onclick: () => {
          rows.splice(index, 1);
          commit();
        },
      }),
    );
    container.appendChild(line);
  });
  container.appendChild(
    h("button", {
      class: "add-btn",
      text: "+ Add",
      onclick: () => {
        rows.push(blank());
        commit();
      },
    }),
  );
  return container;
}

export function columnNames(columns) {
  return columns.map((column) => column.name);
}

/** DuckDB's numeric types, for the pickers that only make sense on numbers. */
export const NUMERIC_TYPE = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;

/*
 * The master switch above a column picker.
 *
 * Grouping a wide table is nearly always "everything" or "everything bar one
 * or two", and ticking thirty boxes to say so is what sends people to the SQL
 * node instead. Indeterminate on a partial selection, with a tally beside it
 * so the count need not be read off the ticks.
 */
export function selectAllToggle(names, chosen, boxes, apply) {
  const master = h("input", { type: "checkbox" });
  const tally = h("span", { class: "check-tally" });
  const sync = () => {
    master.checked = chosen.size === names.length;
    master.indeterminate = chosen.size > 0 && chosen.size < names.length;
    tally.textContent = `${chosen.size} of ${names.length}`;
  };
  master.addEventListener("change", () => {
    chosen.clear();
    if (master.checked) for (const name of names) chosen.add(name);
    // A column tick does not re-render the panel — that would steal focus from
    // whatever else is being edited — so the boxes are updated in place.
    for (const [name, box] of boxes) box.checked = chosen.has(name);
    sync();
    apply();
  });
  sync();
  const row = h("label", { class: "check check-all" }, [master, h("span", { text: "Select all" }), tally]);
  return { row, sync };
}

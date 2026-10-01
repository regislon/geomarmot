/*
 * Picking attributes by typing.
 *
 * A wide table has dozens of attributes, and scrolling a dropdown for one of
 * them is slow. `columnSelect` is a combobox: type part of a name to filter
 * the list, choose with the arrow keys and Enter or with a click, Escape to
 * back out. Leaving the field keeps a name typed in full, and otherwise goes
 * back to the last choice, so a half-typed name never reaches the node.
 * `filterChecks` puts the same filter above a list of check boxes.
 */

import { h } from "./widgets.js";

let pickers = 0;

const matches = (names, text) => {
  const needle = text.trim().toLowerCase();
  if (!needle) return names;
  const starts = names.filter((name) => name.toLowerCase().startsWith(needle));
  const contains = names.filter(
    (name) => !name.toLowerCase().startsWith(needle) && name.toLowerCase().includes(needle),
  );
  return [...starts, ...contains];
};

/**
 * @param {string[]} names    the attributes on offer
 * @param {string} value      the current choice ("" for none)
 * @param {(name: string) => void} onChange
 * @param {string} [placeholder]
 */
export function columnSelect(names, value, onChange, placeholder = "type to find an attribute") {
  const id = `column-picker-${++pickers}`;
  let chosen = value || "";
  let shown = [];
  let active = -1;

  const input = h("input", {
    type: "text",
    class: "column-input",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": id,
    "aria-autocomplete": "list",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: names.length ? placeholder : "connect an input first",
  });
  input.value = chosen;
  const list = h("ul", { id, class: "column-options", role: "listbox", hidden: "" });
  const root = h("div", { class: "column-picker" }, [input, list]);
  const mark = () => {
    const unknown = chosen && names.length && !names.includes(chosen);
    root.classList.toggle("unknown", Boolean(unknown));
    root.title = unknown ? `There is no attribute called “${chosen}” on the input.` : "";
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const choose = (name) => {
    chosen = name;
    input.value = name;
    close();
    mark();
    onChange(name);
  };
  const highlight = (index) => {
    active = index;
    [...list.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
    list.children[index]?.scrollIntoView({ block: "nearest" });
  };
  const open = () => {
    shown = matches(names, input.value === chosen ? "" : input.value);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((name, i) =>
            h("li", {
              role: "option",
              text: name,
              "aria-selected": "false",
              // mousedown, not click: it lands before the input's blur.
              onmousedown: (event) => {
                event.preventDefault();
                choose(name);
              },
              onmouseenter: () => highlight(i),
            }),
          )
        : [h("li", { class: "none", text: names.length ? "No attribute matches." : "No attributes yet." })]),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (shown.length) highlight(Math.max(0, shown.indexOf(chosen)));
  };

  input.addEventListener("focus", () => {
    input.select();
    open();
  });
  input.addEventListener("input", () => {
    open();
    if (shown.length) highlight(0);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) return open();
      if (shown.length) highlight((active + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      input.value = chosen;
      close();
    }
  });
  input.addEventListener("blur", () => {
    const typed = input.value.trim();
    const exact = names.find((name) => name.toLowerCase() === typed.toLowerCase());
    if (!typed && chosen) choose("");
    else if (exact && exact !== chosen) choose(exact);
    else input.value = chosen;
    close();
  });
  mark();
  return root;
}

/**
 * A filter box over a list of check boxes, one per name: typing hides the
 * names that do not match. Returns the box and the names currently shown.
 * @param {Map<string, HTMLInputElement>} boxes
 * @param {() => void} [onFilter]
 */
export function filterChecks(boxes, onFilter = () => {}) {
  const input = h("input", {
    type: "search",
    class: "check-filter",
    placeholder: "Filter attributes",
    "aria-label": "Filter attributes",
  });
  const visible = () => [...boxes].filter(([, box]) => !box.closest("label").hidden).map(([name]) => name);
  input.addEventListener("input", () => {
    const needle = input.value.trim().toLowerCase();
    for (const [name, box] of boxes)
      box.closest("label").hidden = Boolean(needle) && !name.toLowerCase().includes(needle);
    onFilter();
  });
  return { input, visible };
}

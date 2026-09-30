/*
 * The parameter editor for the selected node.
 *
 * Every field is driven by the transformer's own `params` declaration, so a new
 * transformer gets an editor for free. Column pickers are populated from the
 * upstream view's real schema rather than from free text — mistyping a column
 * name is the most common way to break a chain, and it should not be possible
 * here.
 */

import { distinctValues, valueSuggestions, isLonLatCode } from "../core/schema.js";
import { VALUE_KINDS, VALUE_TYPES, FORMULA_OPERATORS, blankValue } from "../core/valuespec.js";
import { checkSql, clearProfiles, PROFILE_ROWS, profileCategories, promptText, schemaText } from "../core/sqlnode.js";
import { transformerFor, OPERATORS, AGGREGATE_FUNCTIONS } from "../../../transformers/legacy.js";

const DISTINCT_VALUE_LIMIT = 50;

function h(tag, attrs = {}, children = []) {
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

function select(options, value, onChange, placeholder = "—") {
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

function textInput(value, onChange, placeholder = "") {
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

function clearStaleSuggestionLists() {
  document.querySelectorAll("datalist[data-pv-suggest]").forEach((list) => list.remove());
}

function suggestingInput(value, onChange, placeholder, context, column) {
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
function repeatable(rows, renderRow, blank, commit) {
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

function columnNames(columns) {
  return columns.map((column) => column.name);
}

/** DuckDB's numeric types, for the pickers that only make sense on numbers. */
const NUMERIC_TYPE = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;

/*
 * The master switch above a column picker.
 *
 * Grouping a wide table is nearly always "everything" or "everything bar one
 * or two", and ticking thirty boxes to say so is what sends people to the SQL
 * node instead. Indeterminate on a partial selection, with a tally beside it
 * so the count need not be read off the ticks.
 */
function selectAllToggle(names, chosen, boxes, apply) {
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

function renderColumnsParam(param, node, columns, commit) {
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

function renderConditionsParam(param, node, context, commit) {
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

function renderRenamesParam(param, node, columns, commit) {
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

/**
 * The "what should this hold?" editor, shared by both nodes that ask.
 *
 * Returns the fields for one spec, laid out as a wrapping group rather than a
 * single line: four controls do not fit across a narrow inspector, and a row
 * that overflows is worse than one that wraps.
 */
function renderValueSpec(spec, columns, commit) {
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

/** AttributeCreator's builder: a name and a value, per new attribute. */
function renderValueRowsParam(param, node, columns, commit) {
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
function renderChoicesParam(param, node, commit) {
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
function renderActionsParam(param, node, columns, commit) {
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

function renderCreatesParam(param, node, columns, commit) {
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

function renderSortsParam(param, node, columns, commit) {
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

function renderAggregatesParam(param, node, columns, commit) {
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

function renderRulesParam(param, node, context, commit) {
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
function renderJoinKeysParam(param, node, context, commit) {
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

/**
 * The AttributeCreator editor: the input's schema, a roomy query box, and a
 * verdict under it.
 *
 * The schema is on show because the query is usually not written here by hand —
 * it is written by an AI given the column names and types, so those have to be
 * visible and copyable rather than something to go hunting for in the attribute
 * grid. The verdict comes from the same check the compiler runs, so what the
 * editor says and what the node does cannot disagree.
 */
function renderSqlCreateParam(param, node, context, commit) {
  const container = h("div");
  const columns = context.columns || [];

  // Filled in once the profile lands; the schema is shown immediately either
  // way, because waiting on two row-scanning queries to show column names
  // would make the panel feel broken.
  let categories = new Map();

  const schema = h("div", { class: "schema-block" });
  const count = h("span", {
    class: "muted",
    text: columns.length ? `input · ${columns.length} columns` : "input · not connected",
  });
  const refresh = h("button", { class: "mini-btn", text: "↻", title: "Re-read the values" });
  const actions = h("span", { class: "schema-actions" }, [refresh]);
  const head = h("div", { class: "schema-head" }, [count, actions]);
  // Copies the rules *and* the schema: the query is usually written by an AI,
  // and one paste that carries both is the difference between a query that
  // compiles first time and one that guesses at the column names.
  const copy = h("button", { class: "mini-btn", text: "Copy for AI" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(promptText(columns, categories));
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy for AI"), 1200);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.appendChild(copy);
  schema.appendChild(head);
  const schemaBody = h("pre", { class: "schema-text", text: schemaText(columns) });
  schema.appendChild(schemaBody);
  container.appendChild(schema);

  const loadCategories = () => {
    if (!columns.length || !context.upstreamView) return;
    count.textContent = `input · ${columns.length} columns · reading values…`;
    profileCategories(context.upstreamView, columns)
      .then((found) => {
        if (!schemaBody.isConnected) return;
        categories = found;
        schemaBody.textContent = schemaText(columns, categories);
        count.textContent = `input · ${columns.length} columns${found.size ? ` · ${found.size} categorical` : ""}`;
        count.title = `Distinct values, from the first ${PROFILE_ROWS.toLocaleString()} rows`;
      })
      .catch(() => {
        /* profileCategories already logged it; the schema stands without values */
      });
  };

  refresh.addEventListener("click", () => {
    clearProfiles();
    loadCategories();
  });
  loadCategories();

  const area = h("textarea", {
    class: "sql-input sql-input-tall",
    rows: 14,
    spellcheck: "false",
    placeholder: param.placeholder || "",
  });
  area.value = node.params[param.id] ?? param.default ?? "";
  container.appendChild(area);

  const verdict = h("p", { class: "sql-verdict muted" });
  container.appendChild(verdict);

  // Debounced: every keystroke would otherwise put a DESCRIBE through DuckDB,
  // and a half-typed query is a guaranteed parser error anyway.
  let timer = null;
  const recheck = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      // The same edit that triggered this also triggered a graph rebuild, which
      // drops the upstream view before recreating it. Checking against it mid
      // rebuild reports "table does not exist", which looks like a fault in the
      // query rather than in the timing — so wait for the graph to settle.
      await context.settle?.();
      const result = await checkSql(area.value, context.upstreamView, columns, {
        requireNewColumns: true,
      });
      // The settle above may have rebuilt the panel; if so this element is
      // detached and a newer editor is already showing its own verdict.
      if (!verdict.isConnected) return;
      verdict.textContent = result.message;
      verdict.className = `sql-verdict ${result.ok ? (result.empty ? "muted" : "ok") : "error"}`;
    }, 350);
  };

  area.addEventListener("input", () => {
    node.params[param.id] = area.value;
    // rerender:false keeps the caret and the textarea's own scroll position;
    // the verdict is updated here instead of by rebuilding the panel.
    commit({ rerender: false });
    recheck();
  });
  recheck();
  return container;
}

function renderSqlTextParam(param, node, commit) {
  const area = h("textarea", {
    class: "sql-input",
    rows: 6,
    spellcheck: "false",
    placeholder: param.placeholder || "",
  });
  area.value = node.params[param.id] ?? param.default ?? "";
  area.addEventListener("input", () => {
    node.params[param.id] = area.value;
    commit({ rerender: false });
  });
  return area;
}

function renderValuesParam(param, node, context, commit) {
  const rows = node.params[param.id] || (node.params[param.id] = []);
  const container = h("div");
  container.appendChild(
    repeatable(
      rows,
      (row, index) => [
        textInput(
          row,
          (value) => {
            rows[index] = value;
            commit({ rerender: false });
          },
          "value",
        ),
      ],
      () => "",
      commit,
    ),
  );
  container.appendChild(
    h("button", {
      class: "add-btn",
      text: "Fill from data",
      onclick: async () => {
        if (!node.params.column || !context.upstreamView) return;
        const found = await distinctValues(context.upstreamView, node.params.column, DISTINCT_VALUE_LIMIT);
        node.params[param.id] = found.map((entry) => String(entry.value));
        commit();
      },
    }),
  );
  return container;
}

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

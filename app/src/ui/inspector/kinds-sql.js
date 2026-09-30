/*
 * Editors for SQL parameters (AttributeCreator's query, SQLTransformer) and
 * for the value list of AttributeFilter.
 */

import { validate } from "../../core/sqlguard/index.js";
import { guardedRead } from "../read-guard.js";
import { distinctValues } from "../../core/schema.js";
import {
  PROFILE_ROWS,
  checkSql,
  clearProfiles,
  profileCategories,
  promptText,
  schemaText,
} from "../../core/sqlnode.js";
import { DISTINCT_VALUE_LIMIT, h, repeatable, textInput } from "./widgets.js";

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
export function renderSqlCreateParam(param, node, context, commit) {
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
    guardedRead(() => profileCategories(context.upstreamView, columns))
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
      // The guard first: restricted SQL never reaches DuckDB until it passes.
      const restricted = (node.sqlMode || "restricted") !== "unrestricted";
      const refusal = restricted && area.value.trim() ? await validate(area.value, "query") : { ok: true };
      const result = !refusal.ok
        ? { ok: false, message: refusal.message }
        : await guardedRead(() => checkSql(area.value, context.upstreamView, columns, { requireNewColumns: true }));
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

export function renderSqlTextParam(param, node, commit) {
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

export function renderValuesParam(param, node, context, commit) {
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
        const found = await guardedRead(() =>
          distinctValues(context.upstreamView, node.params.column, DISTINCT_VALUE_LIMIT),
        );
        node.params[param.id] = found.map((entry) => String(entry.value));
        commit();
      },
    }),
  );
  return container;
}

/*
 * The attribute grid.
 *
 * Paginated against the node's view rather than materialised: the grid asks for
 * fifty rows at a time, so pointing it at a hundred-million-row parquet costs
 * the same as pointing it at a hundred.
 *
 * The geometry column is deliberately not shown. A WKB blob renders as
 * thousands of unreadable bytes that push every real attribute off-screen, and
 * the geometry has its own panel.
 */

import { query, qid } from "./duck.js";
import { H3_INDEX_COLUMN } from "./h3.js";
import { findGeometryColumn, wkbExpression } from "./schema.js";

const PAGE_SIZE = 50;
const MAX_CELL_CHARS = 200;

/** Column the page query smuggles each row's geometry in, never displayed. */
const GEOMETRY_ALIAS = "_pv_geom";

let elements = {};
let state = { view: null, columns: [], page: 0, total: 0, pick: null };

function formatCell(value) {
  if (value === null || value === undefined) return { text: "null", isNull: true };
  if (value instanceof Uint8Array) return { text: `<${value.length} bytes>`, isNull: false };
  if (typeof value === "object") return { text: JSON.stringify(value), isNull: false };
  return { text: String(value), isNull: false };
}

async function copyToClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    console.warn("Clipboard write refused", err);
  }
}

function renderHead() {
  const row = document.createElement("tr");
  // Narrow, unlabelled: the button in it says what it does, and a header word
  // would be wider than the column it sits over.
  if (state.pick) row.appendChild(document.createElement("th")).className = "row-info";
  for (const column of state.columns) {
    const cell = document.createElement("th");
    cell.textContent = column.name;
    cell.title = `${column.name} — ${column.type}`;
    row.appendChild(cell);
  }
  elements.head.replaceChildren(row);
}

function renderBody(rows) {
  const body = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    // Zoom to this row's feature. The geometry travels with the page rather
    // than being looked up on click: the view has no stable key to look a row
    // up by, and re-querying by offset would trust an ordering DuckDB never
    // promised.
    if (state.pick) {
      const value = row[GEOMETRY_ALIAS];
      tr.addEventListener("click", () => {
        elements.body.querySelectorAll("tr.picked").forEach((other) => other.classList.remove("picked"));
        tr.classList.add("picked");
        if (value != null) elements.onPick?.({ kind: state.pick, value });
      });

      // Its own column rather than a corner of the first cell: this asks a
      // different question from the row click, and burying it in an attribute
      // would make it look like it was about that attribute.
      const cell = document.createElement("td");
      cell.className = "row-info";
      const info = document.createElement("button");
      info.className = "info-btn";
      info.textContent = "\u24D8";
      info.title = "Geometry of this feature";
      info.disabled = value == null;
      info.addEventListener("click", (event) => {
        event.stopPropagation();
        elements.onInfo?.({ kind: state.pick, value });
      });
      cell.appendChild(info);
      tr.appendChild(cell);
    }
    for (const column of state.columns) {
      const { text, isNull } = formatCell(row[column.name]);
      const td = document.createElement("td");
      if (isNull) td.className = "null";
      // The full value lives on the title and on the copy button; the cell text
      // is truncated so one long JSON column cannot make the row unreadable.
      td.title = text;
      td.textContent = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
      const copy = document.createElement("button");
      copy.className = "cell-copy";
      copy.textContent = "⧉";
      copy.title = "Copy value";
      copy.addEventListener("click", (event) => {
        event.stopPropagation();
        copyToClipboard(text);
      });
      td.appendChild(copy);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  elements.body.replaceChildren(body);
}

function renderMeta(note) {
  if (!state.view) {
    elements.meta.textContent = note || "No node selected.";
    return;
  }
  const first = state.total ? state.page * PAGE_SIZE + 1 : 0;
  const last = Math.min((state.page + 1) * PAGE_SIZE, state.total);
  elements.meta.textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${state.total.toLocaleString()} rows${note ? ` · ${note}` : ""}`;
}

async function loadPage() {
  const columnSql = state.columns.map((column) => qid(column.name)).join(", ");
  if (!columnSql && !state.pickExpr) {
    elements.head.replaceChildren();
    elements.body.replaceChildren();
    renderMeta("no attribute columns");
    return;
  }
  const selection = [columnSql, state.pickExpr && `${state.pickExpr} AS ${qid(GEOMETRY_ALIAS)}`]
    .filter(Boolean)
    .join(", ");
  const rows = await query(
    `SELECT ${selection} FROM ${state.view} LIMIT ${PAGE_SIZE} OFFSET ${state.page * PAGE_SIZE}`,
  );
  renderHead();
  renderBody(rows);
}

let sheets = [];
let activeSheet = 0;

function renderTabs() {
  const bar = elements.tabs;
  if (!bar) return;
  // One sheet needs no tab strip — the panel heading already names it.
  bar.hidden = sheets.length < 2;
  bar.replaceChildren();
  if (sheets.length < 2) return;
  sheets.forEach((sheet, index) => {
    const tab = document.createElement("div");
    tab.className = `sheet-tab${index === activeSheet ? " active" : ""}`;

    // The swatch doubles as the map toggle: it is already the thing that says
    // "this colour is mine on the map", so it is the obvious thing to click to
    // take that colour off the map. Filled means shown, hollow means hidden.
    const swatch = document.createElement("button");
    swatch.className = `sheet-swatch${sheet.visible === false ? " off" : ""}`;
    swatch.style.setProperty("--swatch", sheet.color);
    swatch.title = sheet.visible === false ? "Show on the map" : "Hide from the map";
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      sheet.visible = sheet.visible === false;
      renderTabs();
      elements.onVisibility?.(sheets);
    });
    tab.appendChild(swatch);

    const name = document.createElement("button");
    name.className = "sheet-name";
    name.textContent = sheet.label;
    name.addEventListener("click", () => {
      if (index === activeSheet) return;
      activeSheet = index;
      renderTabs();
      showSheet(sheets[index]).catch((err) => console.warn("Sheet failed", err));
      elements.onSheetChange?.(sheets[index]);
    });
    tab.appendChild(name);
    bar.appendChild(tab);
  });
}

/**
 * Show several nodes as tabbed sheets.
 *
 * Only the active sheet is queried: with three inspected nodes the other two
 * cost nothing until you look at them.
 */
export async function showSheets(nextSheets) {
  sheets = nextSheets;
  if (activeSheet >= sheets.length) activeSheet = 0;
  renderTabs();
  if (!sheets.length) {
    clearTable("Select a node.");
    return;
  }
  await showSheet(sheets[activeSheet]);
}

/** The sheet currently on screen. */
export function currentSheet() {
  return sheets[activeSheet] || null;
}

/**
 * Set one sheet's map visibility from outside.
 *
 * The map's own legend toggles the same thing the swatch does, and two controls
 * for one piece of state have to read from it rather than each keeping a copy —
 * otherwise a hollow swatch ends up next to a legend entry that says "shown".
 */
export function setSheetVisible(key, visible) {
  const sheet = sheets.find((candidate) => candidate.key === key);
  if (!sheet || sheet.visible === visible) return;
  sheet.visible = visible;
  renderTabs();
}

async function showSheet(sheet) {
  await showView(sheet.view, sheet.columns);
}

/** Point the grid at a node's output view. */
export async function showView(viewName, columns) {
  const geometry = findGeometryColumn(columns);
  const h3 = columns.find((column) => column.name === H3_INDEX_COLUMN);
  state = {
    view: viewName,
    columns: columns.filter((column) => column.name !== geometry?.name),
    page: 0,
    total: 0,
    // Real geometry wins; an H3 index is the fallback the map can also draw.
    pick: geometry ? "wkb" : h3 ? "h3" : null,
    pickExpr: geometry ? wkbExpression(geometry) : h3 ? qid(H3_INDEX_COLUMN) : null,
  };
  const counted = await query(`SELECT count(*) AS n FROM ${viewName}`);
  state.total = Number(counted[0]?.n ?? 0);
  await loadPage();
  // Says where the column went, not what the map did with it — the map may
  // well have refused to draw it, and this line must not contradict that.
  renderMeta(geometry ? `${geometry.name} hidden here, see the map` : null);
}

export function clearTable(message) {
  state = { view: null, columns: [], page: 0, total: 0, pick: null, pickExpr: null };
  elements.head.replaceChildren();
  elements.body.replaceChildren();
  renderMeta(message);
}

async function step(delta) {
  const maxPage = Math.max(0, Math.ceil(state.total / PAGE_SIZE) - 1);
  const next = Math.min(maxPage, Math.max(0, state.page + delta));
  if (next === state.page) return;
  state.page = next;
  await loadPage();
  renderMeta();
}

export function initTable(config) {
  elements = config;
  elements.prev.addEventListener("click", () => step(-1));
  elements.next.addEventListener("click", () => step(1));
  clearTable();
}

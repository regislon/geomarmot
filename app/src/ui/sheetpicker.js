/*
 * The sheet picker: which sheets of a workbook to open, and where each one's
 * column names are.
 *
 * Two steps. First the sheets: every
 * sheet costs a table the moment it is opened (see xlsx.js), and a workbook's
 * extra sheets are as often lookup lists, pivots and notes as they are data,
 * so they are ticked rather than all opened. The first sheet with rows starts
 * ticked; a workbook with only one skips straight to the second step.
 *
 * Then the header row, per chosen sheet. Reports put a title, a date range
 * and a blank line above their table, so "the first row is the header" is
 * wrong often enough to matter — and a wrong header is not an error, just a
 * table whose columns are named after the title and whose first rows are
 * junk. The step shows the top of the sheet as Excel would, with its row
 * numbers; clicking a row makes it the header and everything above it is
 * skipped. It starts on the worker's guess (see `suggestHeader`).
 *
 * `pickSheets` returns a promise: `[{name, headerRow}]`, or null when the
 * picker was dismissed, which the caller treats as "open nothing".
 */

let elements = {};
let settle = null;

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

/** Excel's column letters: 0 → A, 25 → Z, 26 → AA. */
function columnLetter(index) {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function sizeLabel(sheet) {
  if (sheet.empty) return "empty";
  const rows = `~${sheet.rows.toLocaleString()} row${sheet.rows === 1 ? "" : "s"}`;
  return `${rows} · ${sheet.columns} column${sheet.columns === 1 ? "" : "s"}`;
}

function finish(result) {
  elements.modal.hidden = true;
  elements.body.replaceChildren();
  const resolve = settle;
  settle = null;
  resolve?.(result);
}

/**
 * Step 1: tick the sheets. Empty sheets are listed but cannot be ticked:
 * seeing that a workbook has a blank "Sheet3" says the file was read whole,
 * not that a sheet went missing.
 */
function renderSheetStep(state) {
  const { sheets, offered, chosen } = state;
  const boxes = new Map();
  const master = h("input", { type: "checkbox" });
  const tally = h("span", { class: "check-tally" });
  const sync = () => {
    master.checked = chosen.size === offered.length;
    master.indeterminate = chosen.size > 0 && chosen.size < offered.length;
    tally.textContent = `${chosen.size} of ${offered.length}`;
    elements.add.disabled = chosen.size === 0;
  };
  master.addEventListener("change", () => {
    chosen.clear();
    if (master.checked) for (const name of offered) chosen.add(name);
    for (const [name, box] of boxes) box.checked = chosen.has(name);
    sync();
  });

  const rows = [h("label", { class: "check check-all" }, [master, h("span", { text: "Select all" }), tally])];
  for (const sheet of sheets) {
    const box = h("input", { type: "checkbox" });
    box.checked = chosen.has(sheet.name);
    box.disabled = sheet.empty;
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(sheet.name);
      else chosen.delete(sheet.name);
      sync();
    });
    if (!sheet.empty) boxes.set(sheet.name, box);
    rows.push(
      h("label", { class: `check sheet-row${sheet.empty ? " disabled" : ""}` }, [
        box,
        h("span", { class: "sheet-name", text: sheet.name }),
        h("span", { class: "sheet-meta", text: sizeLabel(sheet) }),
      ]),
    );
  }

  elements.hint.textContent = "Step 1 of 2 — pick the sheets to open. Each one becomes its own layer.";
  elements.body.replaceChildren(h("div", { class: "check-list sheet-list" }, rows));
  elements.back.hidden = true;
  elements.add.textContent = "Next: header rows";
  elements.add.onclick = () => {
    // Keep the workbook's own sheet order, not the order boxes were ticked in.
    state.picked = offered.filter((name) => chosen.has(name));
    state.current = state.picked[0];
    renderHeaderStep(state);
  };
  sync();
}

/** The preview grid for one sheet, with the header row and the skipped rows marked. */
function previewTable(preview, headerRow, onPick) {
  const width = Math.max(1, ...preview.rows.map((row) => row.length));
  const head = h("tr", {}, [h("th", { class: "sheet-corner" })]);
  for (let c = 0; c < width; c++) head.appendChild(h("th", { text: columnLetter(preview.startCol + c) }));
  const body = h("tbody");
  preview.rows.forEach((row, i) => {
    const sheetRow = preview.startRow + i;
    const role = sheetRow < headerRow ? "skipped" : sheetRow === headerRow ? "header-row" : "";
    const line = h("tr", { class: role, title: `Use row ${sheetRow} as the header` }, [
      h("th", { class: "sheet-rownum", text: String(sheetRow) }),
    ]);
    for (let c = 0; c < width; c++) line.appendChild(h("td", { text: row[c] ?? "" }));
    line.addEventListener("click", () => onPick(sheetRow));
    body.appendChild(line);
  });
  if (preview.moreRows) {
    body.appendChild(
      h("tr", { class: "sheet-more" }, [h("td", { colspan: String(width + 1), text: "… more rows below" })]),
    );
  }
  return h("div", { class: "sheet-preview" }, [h("table", {}, [h("thead", {}, [head]), body])]);
}

/**
 * Step 2: the header row of each chosen sheet, one tab per sheet. Previews
 * are asked for lazily and kept, so flicking between tabs costs nothing.
 */
async function renderHeaderStep(state) {
  const { picked, headers, previews } = state;
  const name = state.current;
  if (!previews.has(name)) previews.set(name, state.preview(name));

  const instruction = "the row that holds the column names. Rows above it are skipped.";
  elements.hint.textContent = state.skippedFirstStep ? `Click ${instruction}` : `Step 2 of 2 — click ${instruction}`;
  elements.back.hidden = state.skippedFirstStep;
  elements.back.onclick = () => renderSheetStep(state);
  elements.add.disabled = false;
  elements.add.textContent = picked.length > 1 ? `Open ${picked.length} sheets` : "Open sheet";
  elements.add.onclick = () => finish(picked.map((sheet) => ({ name: sheet, headerRow: headers.get(sheet) ?? null })));

  const tabs =
    picked.length > 1
      ? h(
          "div",
          { class: "sheet-tabs" },
          picked.map((sheet) => {
            const row = headers.get(sheet);
            const tab = h("button", {
              class: `sheet-tab${sheet === name ? " active" : ""}`,
              text: row ? `${sheet} · row ${row}` : sheet,
            });
            tab.addEventListener("click", () => {
              state.current = sheet;
              renderHeaderStep(state);
            });
            return tab;
          }),
        )
      : null;
  const holder = h("div", { class: "sheet-preview-holder" }, [h("p", { class: "muted", text: "Reading the sheet…" })]);
  elements.body.replaceChildren(...(tabs ? [tabs] : []), holder);

  let preview;
  try {
    preview = await previews.get(name);
  } catch (err) {
    holder.replaceChildren(h("p", { class: "muted error", text: err.message }));
    return;
  }
  // The user may have switched tabs, or closed the picker, while this loaded.
  if (state.current !== name || elements.modal.hidden) return;
  if (!headers.has(name)) headers.set(name, preview.suggested);

  const pick = (row) => {
    headers.set(name, row);
    renderHeaderStep(state);
  };
  const input = h("input", {
    type: "number",
    min: String(preview.startRow),
    step: "1",
    value: String(headers.get(name)),
  });
  input.addEventListener("change", () => {
    const row = Math.max(preview.startRow, Math.round(Number(input.value)));
    if (Number.isFinite(row)) pick(row);
  });
  const suggested = headers.get(name) === preview.suggested ? "suggested" : `suggested: row ${preview.suggested}`;
  const controls = h("div", { class: "sheet-header-controls" }, [
    h("label", { class: "field-label", text: "Header row" }),
    input,
    h("span", { class: "muted", text: suggested }),
    ...(preview.moreColumns ? [h("span", { class: "muted", text: "· first 26 columns shown" })] : []),
  ]);
  holder.replaceChildren(controls, previewTable(preview, headers.get(name), pick));
  holder.querySelector("tr.header-row")?.scrollIntoView({ block: "nearest" });
}

/**
 * Ask which sheets of `fileName` to open, and each one's header row.
 * `preview(name)` resolves to the worker's preview of that sheet.
 */
export function pickSheets(fileName, sheets, preview) {
  // A second workbook dropped while the picker is up replaces the first ask.
  if (settle) finish(null);

  const offered = sheets.filter((sheet) => !sheet.empty).map((sheet) => sheet.name);
  const state = {
    sheets,
    offered,
    chosen: new Set(offered.slice(0, 1)),
    picked: [],
    current: null,
    headers: new Map(),
    previews: new Map(),
    preview,
    skippedFirstStep: offered.length === 1,
  };

  elements.title.textContent = fileName;
  elements.modal.hidden = false;
  if (state.skippedFirstStep) {
    state.picked = offered;
    state.current = offered[0];
    renderHeaderStep(state);
  } else {
    renderSheetStep(state);
  }
  return new Promise((resolve) => {
    settle = resolve;
  });
}

export function initSheetPicker(config) {
  elements = config;
  elements.close.addEventListener("click", () => finish(null));
  // Clicking the backdrop closes; clicking the panel must not.
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) finish(null);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden) finish(null);
  });
}

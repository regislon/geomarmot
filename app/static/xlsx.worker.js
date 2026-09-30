/*
 * The spreadsheet worker: every SheetJS call that can take a while.
 *
 * SheetJS parses and writes synchronously. On the page, a 30 MB workbook
 * freezes the tab for as long as it takes — the progress bar cannot repaint,
 * the cursor cannot move, and the user reasonably concludes it has hung. Here
 * it blocks nothing but this thread, and the page is told what stage it is at.
 *
 * Messages carry an `id`; each request gets `progress` messages and then one
 * `done` or `error` with the same id. A parsed workbook stays here, keyed by
 * the id of the `open` that parsed it, until `close` — so the sheet picker can
 * sit open without the file being parsed twice.
 *
 * Protocol:
 *   open  {bytes}                → done {book, sheets: [{name, rows, columns, empty}]}
 *   preview {book, name}         → done {startRow, startCol, rows, moreRows, moreColumns, suggested}
 *   sheet {book, name, batch, headerRow}
 *                                → progress {batch: {bytes, from, to}} per batch,
 *                                  then done {names, types, rows} (null when empty)
 *   close {book}                 → done {}
 *   write {names, kinds, ndjson, sheetName} → done {bytes, blanked}
 */

import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

/** Excel's hard limit on one cell's text; longer and Excel "repairs" the file. */
const MAX_CELL_TEXT = 32_767;

const books = new Map();

function post(id, type, payload = {}, transfer = []) {
  self.postMessage({ id, type, ...payload }, transfer);
}

/* ---------- reading ---------- */

/**
 * Every sheet with its size, read from the sheet's declared range alone.
 *
 * The range is what Excel saved as the used area, which a formatted-but-blank
 * row can stretch — so the row count is an upper bound, and a sheet with no
 * range at all is the only one known to be empty.
 */
function listSheets(workbook) {
  return workbook.SheetNames.map((name) => {
    const ref = workbook.Sheets[name]?.["!ref"];
    if (!ref) return { name, rows: 0, columns: 0, empty: true };
    const range = XLSX.utils.decode_range(ref);
    // The first row of the range is the header.
    const rows = range.e.r - range.s.r;
    return { name, rows, columns: range.e.c - range.s.c + 1, empty: rows <= 0 };
  });
}

/**
 * A cell date as `YYYY-MM-DD HH:MM:SS`, read in local time.
 *
 * SheetJS builds the Date so that its local fields equal what the cell shows;
 * going through toISOString() would shift every date by the viewer's UTC
 * offset, and a midnight date west of Greenwich would land on the day before.
 *
 * Rounded to the second first: a time is stored as a fraction of a day, so
 * 13:32:00 comes back as 13:31:59.9999…, and truncating it — as the fields
 * alone would — loses a second on about one timestamp in five. Excel rounds.
 */
function isoLocal(cellDate) {
  const date = new Date(Math.round(cellDate.getTime() / 1000) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Column names from the header row.
 *
 * The first non-blank row is the header — the one layout nobody has to be
 * told about. A blank header cell becomes `column_<n>` and a repeated one gets
 * a `_2` suffix, because DuckDB refuses a table with two columns of one name
 * and a merged title cell is the usual way to produce both.
 */
function headerNames(headerRow, width) {
  const seen = new Map();
  const names = [];
  for (let i = 0; i < width; i++) {
    const raw = headerRow[i];
    const text = raw == null ? "" : String(raw instanceof Date ? isoLocal(raw) : raw).trim();
    const base = text || `column_${i + 1}`;
    const count = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), count);
    names.push(count === 1 ? base : `${base}_${count}`);
  }
  return names;
}

/**
 * The DuckDB type a column's cells agree on.
 *
 * Excel stores a type per cell, not per column, so this is decided from every
 * cell rather than a sample: a column is numeric only when all of it is, and
 * one stray word makes it text. That is also what keeps an ID typed as text
 * — "007" — from being read back as the number 7, which a CSV cannot promise.
 */
function columnType(rows, column) {
  let kind = null;
  let integral = true;
  let midnight = true;
  for (const row of rows) {
    const value = row[column];
    if (value == null) continue;
    const here =
      value instanceof Date
        ? "date"
        : typeof value === "number" || typeof value === "boolean"
          ? typeof value
          : "text";
    if (kind && kind !== here) return "VARCHAR";
    kind = here;
    if (here === "number" && !Number.isSafeInteger(value)) integral = false;
    if (here === "date" && !isoLocal(value).endsWith(" 00:00:00")) midnight = false;
  }
  if (kind === "number") return integral ? "BIGINT" : "DOUBLE";
  if (kind === "boolean") return "BOOLEAN";
  if (kind === "date") return midnight ? "DATE" : "TIMESTAMP";
  return "VARCHAR";
}

/** A cell as the JSON value its column's type expects. */
function cellValue(value, type) {
  if (value == null) return null;
  if (value instanceof Date) {
    const text = isoLocal(value);
    return type === "DATE" ? text.slice(0, 10) : text;
  }
  if (type === "VARCHAR") return String(value);
  return value;
}

function openBook(id, { bytes }) {
  post(id, "progress", { stage: "parse" });
  const workbook = XLSX.read(bytes, { cellDates: true, dense: true });
  books.set(id, workbook);
  post(id, "done", { book: id, sheets: listSheets(workbook) });
}

/* ---------- the header row ---------- */

/** Rows and columns shown in the header-row preview. */
const PREVIEW_ROWS = 40;
const PREVIEW_COLUMNS = 26;
const PREVIEW_CELL_TEXT = 60;

/** A cell's displayed text that is plainly a number, a date or a percentage. */
const NUMERIC_TEXT = /^[-+(]?[\d\s.,/:%€$£-]+\)?$/;

/**
 * Which row most likely holds the column names.
 *
 * Reports put a title, a date range and a blank line above the table, so the
 * first non-blank row is often a one-cell title. The header is taken as the
 * first row that is about as wide as the table below it and mostly text —
 * a title is one cell wide, a data row is mostly numbers. It is only a
 * default: the picker shows the rows and lets the user click another.
 */
function suggestHeader(rows) {
  const filled = rows.map((row) => row.filter((cell) => String(cell).trim() !== ""));
  const widest = Math.max(0, ...filled.map((cells) => cells.length));
  if (!widest) return 0;
  const needed = Math.max(Math.min(2, widest), Math.ceil(widest * 0.5));
  const index = filled.findIndex((cells) => {
    if (cells.length < needed) return false;
    const textual = cells.filter((cell) => !NUMERIC_TEXT.test(String(cell).trim())).length;
    return textual >= cells.length * 0.6;
  });
  return index >= 0 ? index : filled.findIndex((cells) => cells.length > 0);
}

/**
 * The top of a sheet as the user would see it in Excel: displayed text,
 * with sheet row numbers and column letters, blank rows kept.
 */
function previewSheet(id, { book, name }) {
  const workbook = books.get(book);
  if (!workbook) throw new Error("The workbook is no longer open; drop it again.");
  const sheet = workbook.Sheets[name];
  const ref = sheet?.["!ref"];
  if (!ref) {
    post(id, "done", { startRow: 1, startCol: 0, rows: [], moreRows: false, moreColumns: false, suggested: 1 });
    return;
  }
  const full = XLSX.utils.decode_range(ref);
  const range = {
    s: full.s,
    e: {
      r: Math.min(full.e.r, full.s.r + PREVIEW_ROWS - 1),
      c: Math.min(full.e.c, full.s.c + PREVIEW_COLUMNS - 1),
    },
  };
  const rows = XLSX.utils
    .sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true, range })
    .map((row) => row.map((cell) => String(cell).slice(0, PREVIEW_CELL_TEXT)));
  post(id, "done", {
    startRow: full.s.r + 1,
    startCol: full.s.c,
    rows,
    moreRows: full.e.r > range.e.r,
    moreColumns: full.e.c > range.e.c,
    suggested: full.s.r + 1 + suggestHeader(rows),
  });
}

/**
 * One sheet as newline-JSON batches, ready for DuckDB's `read_json`.
 *
 * `headerRow` is the sheet row (1-based, as Excel numbers them) holding the
 * column names; everything above it is skipped. Without one, the first
 * non-blank row is the header. A column with no name and no values — a
 * title block in column A beside a table that starts in B — is dropped
 * rather than arriving as an empty `column_1`.
 *
 * The batches are built here and transferred, not copied, so the page only
 * ever registers bytes and runs an INSERT — the per-cell work is all off the
 * main thread.
 */
function readSheet(id, { book, name, batch, headerRow = null }) {
  const workbook = books.get(book);
  if (!workbook) throw new Error("The workbook is no longer open; drop it again.");
  post(id, "progress", { stage: "rows" });
  const options = { header: 1, raw: true, defval: null, blankrows: false };
  // A number `range` keeps the sheet's own columns and starts at that row.
  if (headerRow) options.range = headerRow - 1;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], options);
  if (!rows.length) {
    post(id, "done", { names: null, types: null, rows: 0 });
    return;
  }
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  const allNames = headerNames(rows[0], width);
  const allBody = rows.slice(1);
  const kept = allNames
    .map((_, i) => i)
    .filter((i) => (rows[0][i] != null && String(rows[0][i]).trim() !== "") || allBody.some((row) => row[i] != null));
  const names = kept.map((i) => allNames[i]);
  const body = kept.length === width ? allBody : allBody.map((row) => kept.map((i) => row[i]));
  const types = names.map((_, i) => columnType(body, i));
  post(id, "progress", { stage: "schema", names, types, total: body.length });

  const encoder = new TextEncoder();
  for (let from = 0; from < body.length; from += batch) {
    const to = Math.min(from + batch, body.length);
    const lines = [];
    for (let r = from; r < to; r++) {
      const record = {};
      const row = body[r];
      for (let i = 0; i < names.length; i++) record[names[i]] = cellValue(row[i], types[i]);
      lines.push(JSON.stringify(record));
    }
    const bytes = encoder.encode(lines.join("\n"));
    post(id, "progress", { batch: { bytes, from, to } }, [bytes.buffer]);
  }
  post(id, "done", { names, types, rows: body.length });
}

/* ---------- writing ---------- */

/**
 * A worksheet cell for one value, by the kind the page assigned its column.
 *
 * Dates arrive as `YYYY-MM-DDTHH:MM:SS` text and are written as Excel's own
 * serial number (days since 1899-12-30) with a date format — which is what a
 * date cell is inside the file, and which carries no time zone. Handing
 * SheetJS a Date instead does not work: it reads dates in local time but
 * writes them as UTC, so every exported date moved by the viewer's offset.
 * Text over Excel's per-cell limit is left blank rather than cut: a truncated
 * WKT is not a shorter polygon, it is a broken one.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function cellFor(value, kind, counter) {
  if (value == null) return null;
  if (kind === "date" || kind === "datetime") {
    const [date, time = "00:00:00"] = String(value).split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm, ss] = time.split(":").map(Number);
    return {
      t: "n",
      v: (Date.UTC(y, m - 1, d, hh, mm, Math.floor(ss)) - EXCEL_EPOCH_MS) / 86_400_000,
      z: kind === "date" ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm:ss",
    };
  }
  if (kind === "number") return { t: "n", v: value };
  if (kind === "boolean") return { t: "b", v: value };
  const text = String(value);
  if (text.length > MAX_CELL_TEXT) {
    counter.blanked += 1;
    return null;
  }
  return { t: "s", v: text };
}

/**
 * Build a one-sheet workbook and write it.
 *
 * The sheet is assembled cell by cell rather than through `json_to_sheet`, so
 * each column's kind decides its cell type once instead of SheetJS guessing
 * per value — a text column of digits stays text, as it did on the way in.
 */
function writeBook(id, { names, kinds, ndjson, sheetName }) {
  const counter = { blanked: 0 };
  const lines = new TextDecoder().decode(ndjson).split("\n").filter((line) => line.length);
  const keys = names.map((_, c) => `c${c}`);
  const sheet = [];
  sheet.push(names.map((name) => ({ t: "s", v: name })));
  const step = Math.max(1, Math.floor(lines.length / 50));
  for (let r = 0; r < lines.length; r++) {
    const record = JSON.parse(lines[r]);
    const out = new Array(names.length);
    for (let c = 0; c < names.length; c++) out[c] = cellFor(record[keys[c]], kinds[c], counter);
    sheet.push(out);
    if (r % step === 0) post(id, "progress", { stage: "cells", done: r, total: lines.length });
  }
  const worksheet = XLSX.utils.aoa_to_sheet(sheet, { dense: true, cellDates: true });
  // A filter on the header row, the first thing anyone adds to an exported
  // table. (Freezing it too would need SheetJS Pro.)
  worksheet["!autofilter"] = { ref: worksheet["!ref"] };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  post(id, "progress", { stage: "zip" });
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }));
  post(id, "done", { bytes, blanked: counter.blanked }, [bytes.buffer]);
}

/* ---------- dispatch ---------- */

const HANDLERS = {
  open: openBook,
  preview: previewSheet,
  sheet: readSheet,
  close: (id, { book }) => {
    books.delete(book);
    post(id, "done");
  },
  write: writeBook,
};

self.onmessage = ({ data }) => {
  const { id, type, ...payload } = data;
  try {
    HANDLERS[type](id, payload);
  } catch (err) {
    post(id, "error", { message: err?.message || String(err) });
  }
};

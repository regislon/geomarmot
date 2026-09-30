/* Excel output: typed cells, WKT geometry, and Excel's own limits enforced. */

import { copyToBuffer, qid, qlit, query } from "../../core/duck.js";
import { LONLAT, describe, findGeometryColumn, geometryExpression, isLonLatCode } from "../../core/schema.js";
import { hideProgress, showProgress } from "../../ui/progress.js";
import { MAX_EXCEL_COLUMNS, MAX_EXCEL_ROWS, writeWorkbook } from "../xlsx.js";
import { download, virtualName } from "./index.js";

/** Integer types that can hold more than a double carries exactly. */
const WIDE_INTEGER = /^(U?BIGINT|HUGEINT|UHUGEINT)$/;
const NUMERIC = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;

/** Largest integer a double represents exactly, 2^53 - 1. */
const MAX_SAFE = "9007199254740991";

/**
 * How each column goes into a worksheet: the SQL that reads it and the kind
 * of cell it becomes.
 *
 * Every number is a double in Excel, so a 64-bit integer column whose values
 * pass 2^53 — an H3 index, a hashed ID — is written as text rather than
 * rounded into a different, valid-looking number. Whether a column needs that
 * is asked of the data, in one query, rather than assumed from its type.
 * Dates go as text the worker rebuilds into date cells; a zoned timestamp,
 * a time of day and anything nested become their text form.
 */
async function excelColumns(viewName, columns, geometry) {
  const wide = columns.filter((column) => column !== geometry && WIDE_INTEGER.test(column.type));
  let tooWide = new Set();
  if (wide.length) {
    const checks = wide.map((column, i) => `bool_or(abs(${qid(column.name)}::HUGEINT) > ${MAX_SAFE}) AS w${i}`);
    const [row] = await query(`SELECT ${checks.join(", ")} FROM ${viewName}`);
    tooWide = new Set(wide.filter((_, i) => row?.[`w${i}`]).map((column) => column.name));
  }
  return columns.map((column) => {
    const ref = qid(column.name);
    if (column === geometry) return { sql: `ST_AsText(${geometryExpression(geometry)})`, kind: "text" };
    if (tooWide.has(column.name)) return { sql: `${ref}::VARCHAR`, kind: "text" };
    if (NUMERIC.test(column.type)) return { sql: `${ref}::DOUBLE`, kind: "number" };
    if (column.type === "BOOLEAN") return { sql: ref, kind: "boolean" };
    if (column.type === "DATE") return { sql: `strftime(${ref}, '%Y-%m-%d')`, kind: "date" };
    if (/^TIMESTAMP(_S|_MS|_NS)?$/.test(column.type)) {
      return { sql: `strftime(${ref}, '%Y-%m-%dT%H:%M:%S')`, kind: "datetime" };
    }
    return { sql: `${ref}::VARCHAR`, kind: "text" };
  });
}

/** Excel's sheet-name rules: 31 characters at most, none of `[]:*?/\`. */
function sheetNameFor(baseName) {
  return baseName.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet1";
}

/*
 * Excel, one sheet, built by SheetJS in the spreadsheet worker so a big
 * export does not freeze the tab.
 *
 * A worksheet has no geometry type, so geometry goes out as WKT in a text
 * column under its own name — readable, and one ST_GeomFromText away from a
 * geometry again, including in this app. Excel holds 1,048,576 rows a sheet
 * and 32,767 characters a cell; an output over the first is refused up front,
 * and a WKT over the second — a detailed polygon easily is — is left blank
 * rather than cut, since a truncated WKT is not a smaller shape but a broken
 * one. The note says how many.
 */
export async function exportExcel(viewName, baseName, crs = LONLAT) {
  const columns = await describe(viewName);
  if (columns.length > MAX_EXCEL_COLUMNS) {
    throw new Error(
      `${columns.length.toLocaleString()} columns is more than Excel's ${MAX_EXCEL_COLUMNS.toLocaleString()} — write Parquet or CSV instead.`,
    );
  }
  const [{ n }] = await query(`SELECT count(*) AS n FROM ${viewName}`);
  if (Number(n) > MAX_EXCEL_ROWS) {
    throw new Error(
      `${Number(n).toLocaleString()} rows is more than one Excel sheet holds (${MAX_EXCEL_ROWS.toLocaleString()}) — ` +
        "filter upstream, or write Parquet or CSV.",
    );
  }
  const geometry = findGeometryColumn(columns);
  try {
    showProgress(`Reading ${Number(n).toLocaleString()} rows for ${baseName}.xlsx…`);
    const plan = await excelColumns(viewName, columns, geometry);
    // Positional aliases, so a column called "n" or "select" cannot collide.
    const selection = plan.map((column, i) => `${column.sql} AS c${i}`).join(", ");
    // Rows leave DuckDB as newline JSON written inside its own worker, and go
    // to the spreadsheet worker as bytes. Pulling them through query() instead
    // builds one JS object per row on the page — seven seconds of frozen tab
    // for 250,000 rows, which is the thing the worker exists to prevent.
    const virtual = virtualName("json");
    const ndjson = await copyToBuffer(
      `COPY (SELECT ${selection} FROM ${viewName}) TO ${qlit(virtual)} (FORMAT JSON)`,
      virtual,
    );

    const { bytes, blanked } = await writeWorkbook(
      {
        names: columns.map((column) => column.name),
        kinds: plan.map((column) => column.kind),
        ndjson,
        sheetName: sheetNameFor(baseName),
      },
      {
        onProgress: ({ stage, done, total }) => {
          if (stage === "zip") showProgress(`Compressing ${baseName}.xlsx…`);
          else
            showProgress(
              `Writing ${baseName}.xlsx — ${done.toLocaleString()} of ${total.toLocaleString()} rows`,
              done / total,
            );
        },
      },
    );
    download(bytes, `${baseName}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const notes = [];
    if (geometry) {
      notes.push(
        `Geometry written as WKT in "${geometry.name}"` +
          (isLonLatCode(crs) ? "." : `, in ${crs} — the file itself cannot say so.`),
      );
    }
    if (blanked) {
      notes.push(
        `${blanked.toLocaleString()} cell${blanked === 1 ? " was" : "s were"} over Excel's 32,767-character limit and left blank.`,
      );
    }
    // Only a CRS or a blanked cell is a caveat; a lon/lat WKT column is just what Excel can hold.
    const caveat = blanked || (geometry && !isLonLatCode(crs));
    return { file: `${baseName}.xlsx`, note: caveat ? notes.join(" ") : null };
  } finally {
    hideProgress();
  }
}

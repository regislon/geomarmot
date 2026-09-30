/* Excel workbooks: one source per chosen sheet, each built into a table. */

import { hideProgress, showProgress } from "../../ui/progress.js";
import { closeWorkbook, materializeSheet, previewSheet, readWorkbook } from "../xlsx.js";
import { blankSource, introspect, sources } from "../sources.js";

/** Distinct table per workbook sheet, so two workbooks with a "Sheet1" can coexist. */
let _sheetCounter = 0;

/**
 * Split a workbook into one source per non-empty sheet.
 *
 * Like a GeoPackage's layers, a workbook's sheets are what people think of as
 * its datasets, so each gets its own row in the Layers rail. Unlike them, a
 * sheet cannot be read in place: the workbook is a zip of XML with no way to
 * reach one sheet's rows without parsing it, so each is built into a table on
 * open, and a remote workbook is fetched whole rather than range-read.
 *
 * Which is why `chooseSheets` exists. It is asked which sheets to open and
 * where each one's column names are — reports put titles above their tables,
 * so the first row is often not the header. It gets the file name, every
 * sheet's summary and a `preview(name)` for the header-row step, and returns
 * `[{name, headerRow}]`, or null to open nothing. Without it, every sheet with
 * rows is opened with its first non-blank row as the header.
 */
export async function xlsxSheetSources(displayName, bytes, origin, extra = {}, chooseSheets = null) {
  showProgress(`Parsing ${displayName}…`);
  const { book, sheets } = await readWorkbook(bytes).catch((err) => {
    hideProgress();
    throw err;
  });
  try {
    let wanted = sheets.filter((sheet) => !sheet.empty).map((sheet) => ({ name: sheet.name, headerRow: null }));
    if (!wanted.length) throw new Error(`${displayName} has no rows in any sheet.`);
    if (chooseSheets) {
      // The bar would sit over the picker saying "parsing" while it waits on a click.
      hideProgress();
      wanted = await chooseSheets(displayName, sheets, (name) => previewSheet(book, name));
      if (!wanted?.length) return [];
    }
    const made = [];
    for (const [index, { name: sheet, headerRow }] of wanted.entries()) {
      const label = wanted.length > 1 ? `Opening ${sheet} (${index + 1} of ${wanted.length})` : `Opening ${sheet}`;
      showProgress(`${label}…`, index / wanted.length);
      _sheetCounter += 1;
      const table = `xlsx_${_sheetCounter}`;
      const built = await materializeSheet(book, sheet, table, {
        headerRow,
        onProgress: ({ stage, done, total }) => {
          if (stage === "rows") {
            showProgress(`${label} — reading cells…`, null);
            return;
          }
          const fraction = (index + (total ? done / total : 1)) / wanted.length;
          showProgress(`${label} — ${done.toLocaleString()} of ${total.toLocaleString()} rows`, fraction);
        },
      });
      if (!built) continue;
      const source = blankSource(table, displayName, origin, {
        ...extra,
        table,
        name: sheets.length > 1 ? `${displayName} \u203a ${sheet}` : displayName,
        layer: sheet,
        headerRow,
      });
      await introspect(source);
      sources.set(source.id, source);
      made.push(source);
    }
    // A sheet whose declared range was only formatting has no rows to build.
    if (!made.length) throw new Error(`${displayName}: the chosen sheets have no rows.`);
    return made;
  } finally {
    hideProgress();
    await closeWorkbook(book);
  }
}

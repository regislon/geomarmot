/*
 * H3 tiles: recovering geometry from a file that carries none.
 *
 * A "dense positional" H3 tile is a file named after its parent cell that holds all 7^n
 * children of that cell at some deeper resolution sorted ascending, and carries
 * no cell column at all — row i *is* sorted_children[i]. A res-6 tile therefore
 * holds 7^7 = 823,543 rows.
 *
 * That row count rules out the obvious implementation. Calling
 * h3.cellToChildren() to build the index would materialise ~800k strings, and
 * building every hexagon boundary up front would be ~100 MB of WKB, for a file
 * whose rows are mostly blanked out-of-scope anyway.
 *
 * So the index is derived arithmetically in SQL instead, from the row number,
 * and costs nothing until a query touches it. The trick is that H3's sorted
 * child order is exactly base-7 counting over the digit fields: an index is
 *
 *   bits 52-55  resolution      bits 45-51  base cell
 *   bits 0-44   fifteen 3-bit digits, the digit for resolution k at bit 45-3k,
 *               with every digit past the cell's own resolution set to 7
 *
 * so child i of a parent at resolution p, taken at resolution r, is the parent
 * with its resolution field set to r and digits p+1..r replaced by i's base-7
 * representation re-read as base 8. Verified cell-for-cell against h3-js.
 *
 * Geometry is then built from the index only where it is actually needed — the
 * map panel's capped preview, and export — rather than being carried as a
 * column through every intermediate view.
 */

import { qid } from "../../core/duck.js";
import { getResolution, isPentagon, isValidCell } from "h3-js";

/** The canonical column this module produces: an H3 cell id as lowercase hex. */
export const H3_INDEX_COLUMN = "h3_index";

/** Physical row number, exposed by the Reader so positional indexing can work. */
export const ROW_NUMBER_COLUMN = "file_row_number";

/** Column names that conventionally hold an H3 cell id in this project's files. */
const INDEX_COLUMN_NAMES = new Set(["h3_index", "h3index", "cell", "cell_id", "h3", "h3_cell", "index"]);

const INTEGER_TYPES = /^(U?BIGINT|U?INTEGER|HUGEINT|UHUGEINT)$/;
const STRING_TYPES = /^(VARCHAR|TEXT|STRING)$/;

const MASK64 = (1n << 64n) - 1n;
const MAX_RESOLUTION = 15;

/**
 * The H3 cell a file is named after, or null.
 *
 * Tolerates a numeric prefix (`0001_866500cdfffffff.parquet`), which tile
 * writers sometimes add, and this app's internal `s1__` prefix.
 */
export function parseParentCell(fileName) {
  const stem = String(fileName).replace(/\.(parquet|pq)$/i, "");
  const candidate = stem.split(/[_/\\]/).pop();
  if (!/^[0-9a-fA-F]{15,16}$/.test(candidate)) return null;
  const hex = candidate.toLowerCase();
  try {
    return isValidCell(hex) ? hex : null;
  } catch {
    return null;
  }
}

/**
 * The child resolution whose child count equals `rowCount`, or null.
 *
 * Walks resolutions until the child count matches the row count — the
 * integrity check a dense tile satisfies by construction.
 */
export function childResolutionFor(parentHex, rowCount) {
  const parentRes = getResolution(parentHex);
  if (rowCount === 1) return parentRes;
  // A pentagon's children skip the deleted subsequence, so there are 6 of them
  // at the first step and the base-7 packing below does not describe the order.
  if (isPentagon(parentHex)) return null;
  for (let digits = 1; parentRes + digits <= MAX_RESOLUTION; digits++) {
    if (7 ** digits === rowCount) return parentRes + digits;
  }
  return null;
}

/**
 * SQL yielding the H3 index of the row at `rowExpr` within a dense tile.
 *
 * `rowExpr` must be the physical row number — use `read_parquet(…,
 * file_row_number=true)`, never `row_number() OVER ()`, which DuckDB is free to
 * assign in whatever order its parallel scan happens to produce.
 */
export function positionalIndexExpr(parentHex, childRes, rowExpr) {
  const parent = BigInt(`0x${parentHex}`);
  const parentRes = getResolution(parentHex);
  const digits = childRes - parentRes;
  const shift = BigInt(45 - 3 * childRes);

  // Clear the digit fields this resolution step owns, then stamp the new one.
  const digitMask = ((1n << BigInt(3 * digits)) - 1n) << shift;
  let base = parent & (~digitMask & MASK64);
  base = (base & (~(0xfn << 52n) & MASK64)) | (BigInt(childRes) << 52n);

  if (digits === 0) return `lpad(lower(hex(${base}::UBIGINT)), 15, '0')`;

  // Read the row number's base-7 digits back out as base 8, which is the same
  // as writing them into consecutive 3-bit fields.
  const terms = [];
  for (let k = 0; k < digits; k++) {
    terms.push(`((${rowExpr} // ${7n ** BigInt(k)}) % 7) * ${8n ** BigInt(k)}`);
  }
  const packed = `(${terms.join(" + ")})::UBIGINT << ${shift}`;
  return `lpad(lower(hex(${base}::UBIGINT | (${packed}))), 15, '0')`;
}

/** SQL reading a hex index column back as the 64-bit integer it encodes. */
function asInteger(column) {
  return `('0x' || ${qid(column)})::UBIGINT`;
}

/** SQL yielding the resolution of a hex index column. */
export function resolutionExpr(column) {
  return `((${asInteger(column)} >> 52) & 15)`;
}

/**
 * SQL yielding the ancestor of a hex index column at `parentRes`.
 *
 * The inverse of the child packing: blank the digit fields the coarser cell
 * does not own by setting them back to 7, and stamp the new resolution. Doing
 * it in SQL is what lets an 823,543-cell tile be rolled up to a few hundred
 * hexagons by DuckDB, instead of shipping every cell to JavaScript first.
 */
export function parentIndexExpr(column, parentRes) {
  // Digits parentRes+1 .. 15 live in the low 45-3p bits.
  const digitMask = (1n << BigInt(45 - 3 * parentRes)) - 1n;
  const clearResolution = ~(0xfn << 52n) & MASK64;
  const setResolution = BigInt(parentRes) << 52n;
  const rolled = `((${asInteger(column)} | ${digitMask}::UBIGINT) & ${clearResolution}::UBIGINT) | ${setResolution}::UBIGINT`;
  return `lpad(lower(hex(${rolled})), 15, '0')`;
}

/** SQL normalising an existing index column to lowercase 15-char hex. */
export function existingIndexExpr(column, columnType) {
  const reference = qid(column);
  if (STRING_TYPES.test(columnType)) return `lpad(lower(${reference}), 15, '0')`;
  return `lpad(lower(hex(${reference}::UBIGINT)), 15, '0')`;
}

/** An H3 index column already present in the file, or null. */
export function findIndexColumn(columns) {
  return (
    columns.find(
      (column) =>
        INDEX_COLUMN_NAMES.has(column.name.toLowerCase()) &&
        (INTEGER_TYPES.test(column.type) || STRING_TYPES.test(column.type)),
    ) || null
  );
}

/**
 * Work out how a source's H3 index should be produced, or null when the file
 * is not an H3 tile.
 *
 * Returns {parent, resolution, mode, column, columnType, note}. `note` is set
 * when the file names a cell but its index cannot be derived, so the UI can say
 * why instead of silently treating it as a plain parquet.
 */
export function describeH3Source(displayName, columns, rowCount) {
  const parent = parseParentCell(displayName);
  if (!parent) return null;

  const existing = findIndexColumn(columns);
  if (existing) {
    return {
      parent,
      resolution: null,
      mode: "column",
      column: existing.name,
      columnType: existing.type,
      note: null,
    };
  }

  const resolution = childResolutionFor(parent, rowCount);
  if (resolution === null) {
    const reason = isPentagon(parent)
      ? `${parent} is a pentagon cell, whose children do not follow the positional order`
      : `${rowCount.toLocaleString()} rows is not a whole number of children of ${parent}`;
    return { parent, resolution: null, mode: "none", column: null, columnType: null, note: reason };
  }
  return { parent, resolution, mode: "positional", column: null, columnType: null, note: null };
}

export * from "./geometry.js";

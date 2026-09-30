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

import {
  POLYGON_TO_CELLS_FLAGS,
  cellToBoundary,
  getResolution,
  isPentagon,
  isValidCell,
  polygonToCellsExperimental,
  // 4.2 rather than 4.1: polygonToCellsExperimental — and with it every fill
  // mode other than "centroid inside" — does not exist before it.
} from "h3-js";

import { db, exec, qid, qlit } from "../core/duck.js";

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

/**
 * The cell's boundary as a closed [lng, lat] ring.
 *
 * `formatAsGeoJson: true` both flips the axis order and closes the ring, so a
 * hexagon comes back as seven points, not six. Closing it again would put a
 * duplicate vertex in every polygon the app draws or exports — valid enough
 * that most readers say nothing, and wrong. The guard is kept in case a future
 * h3-js stops closing it.
 */
function closedRing(hex) {
  const ring = cellToBoundary(hex, true);
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  return firstLng === lastLng && firstLat === lastLat ? ring : [...ring, ring[0]];
}

/**
 * Sanity ceiling on hexagons built for one node.
 *
 * High, because the build is chunked: a whole res-6 dense tile (823,543 cells)
 * is meant to work. This exists only to catch a runaway, not to ration.
 */
/*
 * Polygon fill modes, named as h3ronpy names them.
 *
 * h3ronpy's ContainmentMode names are widely used in Python H3 work, so they
 * are what the node offers — but they are h3o's names, and h3o is not the
 * library doing the work here. Three of the four map exactly onto an H3 flag.
 * The fourth, IntersectsBoundary, does not: h3o documents it as returning
 * nothing for a geometry that sits entirely inside one cell, whereas H3's
 * `containmentOverlapping` returns the covering cell (measured: 1 cell, not 0).
 * That is h3o's `Covers`, so `Covers` is what this is called, and
 * IntersectsBoundary is left out rather than mapped to something it is not.
 */
export const FILL_MODES = {
  ContainsCentroid: POLYGON_TO_CELLS_FLAGS.containmentCenter,
  ContainsBoundary: POLYGON_TO_CELLS_FLAGS.containmentFull,
  Covers: POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  // H3's own fourth flag, with no h3ronpy equivalent: cheap and generous, it
  // takes every cell overlapping the bounding box rather than the shape.
  CoversBoundingBox: POLYGON_TO_CELLS_FLAGS.containmentOverlappingBbox,
};

export const MAX_MATERIALISED_CELLS = 2_000_000;

/** Cells per insert. ~3 MB of hex in flight per batch, and a yield between each. */
const CELL_CHUNK = 25_000;

// Byte -> two hex chars, precomputed. The naive toString(16).padStart(2,"0")
// per byte is ~100M calls for a full tile, and dominates the build.
const HEX_BYTE = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

function toHex(bytes) {
  const parts = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX_BYTE[bytes[i]];
  return parts.join("");
}

let reportProgress = null;

/** Where long builds announce themselves; the app points this at the status line. */
export function setProgressReporter(fn) {
  reportProgress = fn;
}

/**
 * Build a `cell -> geometry` table for the given H3 indexes.
 *
 * Inserted in batches rather than as one buffer: a full tile is ~200 MB of hex
 * if encoded in one go, and the await between batches also hands the main
 * thread back so the page keeps responding. The rows travel as newline JSON,
 * which keeps this dependency-free — `unhex` turns the WKB back into bytes and
 * ST_GeomFromWKB into a real geometry.
 */
export async function createCellGeometryTable(cells, tableName) {
  await exec(`CREATE OR REPLACE TABLE ${tableName} (cell VARCHAR, geometry GEOMETRY)`);
  const encoder = new TextEncoder();
  for (let start = 0; start < cells.length; start += CELL_CHUNK) {
    const slice = cells.slice(start, start + CELL_CHUNK);
    const lines = slice.map((cell) => JSON.stringify({ cell, wkb: toHex(cellToWkb(cell)) })).join("\n");
    const jsonName = `${tableName}_${start}.json`;
    await db().registerFileBuffer(jsonName, encoder.encode(lines));
    try {
      await exec(
        `INSERT INTO ${tableName}
         SELECT cell, ST_GeomFromWKB(unhex(wkb)) FROM read_json_auto(${qlit(jsonName)})`,
      );
    } finally {
      await db().dropFile(jsonName);
    }
    if (cells.length > CELL_CHUNK) {
      reportProgress?.(
        `Building hexagons… ${Math.min(start + CELL_CHUNK, cells.length).toLocaleString()} of ${cells.length.toLocaleString()}`,
      );
    }
  }
  return tableName;
}

/**
 * Cells covering one GeoJSON geometry, at one resolution, under one fill mode.
 *
 * Polygon and MultiPolygon only — a fill has no meaning for a point or a line,
 * and quietly returning nothing for them would look like a broken node.
 */
function cellsForGeometry(geometry, resolution, flag) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") {
    return polygonToCellsExperimental(geometry.coordinates, resolution, flag, true);
  }
  if (geometry.type === "MultiPolygon") {
    const cells = new Set();
    for (const part of geometry.coordinates) {
      for (const cell of polygonToCellsExperimental(part, resolution, flag, true)) cells.add(cell);
    }
    return [...cells];
  }
  return [];
}

/**
 * Fill every row's geometry with cells, into a `feature -> cell` table.
 *
 * One row per (feature, cell) pair, which is the shape that joins back to the
 * attributes. `rows` carries the feature id alongside the GeoJSON so the pairing
 * survives; ids come from a materialised table upstream, because a row number
 * computed in one scan is not guaranteed to match the next.
 */
export async function createPolygonFillTable(rows, resolution, mode, tableName) {
  const flag = FILL_MODES[mode] ?? FILL_MODES.ContainsCentroid;
  // The hexagon travels with the cell. The boundary is already in hand here, so
  // carrying it costs one WKB per cell — where deriving it later means a second
  // node and a second pass over every cell.
  await exec(`CREATE OR REPLACE TABLE ${tableName} (fid BIGINT, cell VARCHAR, geometry GEOMETRY)`);
  const encoder = new TextEncoder();

  let pairs = [];
  let written = 0;
  const flush = async () => {
    if (!pairs.length) return;
    const jsonName = `${tableName}_${written}.json`;
    await db().registerFileBuffer(jsonName, encoder.encode(pairs.map((pair) => JSON.stringify(pair)).join("\n")));
    try {
      await exec(
        `INSERT INTO ${tableName}
         SELECT fid, cell, ST_GeomFromWKB(unhex(wkb)) FROM read_json_auto(${qlit(jsonName)})`,
      );
    } finally {
      await db().dropFile(jsonName);
    }
    written += pairs.length;
    pairs = [];
    reportProgress?.(`Filling polygons… ${written.toLocaleString()} cells`);
  };

  let total = 0;
  for (const row of rows) {
    let geometry;
    try {
      geometry = JSON.parse(row.geojson);
    } catch {
      continue;
    }
    const cells = cellsForGeometry(geometry, resolution, flag);
    total += cells.length;
    if (total > MAX_MATERIALISED_CELLS) {
      throw new Error(
        `Over ${MAX_MATERIALISED_CELLS.toLocaleString()} cells at resolution ${resolution}. ` +
          "Use a coarser resolution, or filter upstream.",
      );
    }
    for (const cell of cells) pairs.push({ fid: row.fid, cell, wkb: toHex(cellToWkb(cell)) });
    if (pairs.length >= CELL_CHUNK) await flush();
  }
  await flush();
  return tableName;
}

/** GeoJSON Polygon for one cell. */
export function cellToPolygon(hex) {
  return { type: "Polygon", coordinates: [closedRing(hex)] };
}

/**
 * Little-endian WKB Polygon for one cell.
 *
 * Written by hand rather than via a library because this is the only geometry
 * shape the module ever emits, and a hexagon is seven points.
 */
export function cellToWkb(hex) {
  const ring = closedRing(hex);
  const bytes = new Uint8Array(1 + 4 + 4 + 4 + ring.length * 16);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1); // little endian
  view.setUint32(1, 3, true); // Polygon
  view.setUint32(5, 1, true); // one ring
  view.setUint32(9, ring.length, true);
  let offset = 13;
  for (const [lng, lat] of ring) {
    view.setFloat64(offset, lng, true);
    view.setFloat64(offset + 8, lat, true);
    offset += 16;
  }
  return bytes;
}

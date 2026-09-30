/*
 * H3 geometry: hexagon boundaries, polygon fills and materialised cell tables,
 * built in JavaScript because DuckDB-Wasm has no H3 extension.
 */

import { db, exec, qlit } from "../../core/duck.js";
// h3-js 4.2 rather than 4.1: polygonToCellsExperimental — and with it every fill
// mode other than "centroid inside" — does not exist before it.
import { POLYGON_TO_CELLS_FLAGS, cellToBoundary, polygonToCellsExperimental } from "h3-js";

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
export async function createCellGeometryTable(cells, tableName, { signal } = {}) {
  await exec(`CREATE OR REPLACE TABLE ${tableName} (cell VARCHAR, geometry GEOMETRY)`);
  const encoder = new TextEncoder();
  for (let start = 0; start < cells.length; start += CELL_CHUNK) {
    // Between batches: a superseded compile stops here rather than finishing the tile.
    if (signal?.aborted) throw new DOMException("The compile was superseded.", "AbortError");
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
export async function createPolygonFillTable(rows, resolution, mode, tableName, { signal } = {}) {
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
    if (signal?.aborted) throw new DOMException("The compile was superseded.", "AbortError");
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

/*
 * Comparing a transformer's output with a fixture's expectation.
 *
 * Geometry is compared here, in JavaScript, with its own JSTS — independent of
 * the spatial functions of the engine under test. Two modes:
 *
 *   exact     same type, dimensions, parts in order, rings with the same start
 *             vertex and orientation, every coordinate (Z included) within
 *             `tolerance`. A case may relax ringStart / orientation / partOrder
 *             through `ignore`, with a reason in `why`.
 *   topology  for output whose vertex placement is an algorithm detail: same
 *             type and dimensions, symmetric-difference area within
 *             `areaTolerance` of the expected area (a buffer of `tolerance` for
 *             lines), discrete Hausdorff distance within `tolerance`, same
 *             validity. Area and bounds alone would accept a different shape.
 */

import "jsts/org/locationtech/jts/monkey.js";
import { WKTReader } from "jsts/org/locationtech/jts/io.js";
import DiscreteHausdorffDistance from "jsts/org/locationtech/jts/algorithm/distance/DiscreteHausdorffDistance.js";
import { parseWkt } from "./wkt.js";

const reader = new WKTReader();

export const DEFAULT_GEOMETRY = { mode: "exact", tolerance: 1e-9, areaTolerance: 1e-6, ignore: [] };

const hasZ = (g) => g.z || JSON.stringify(g.parts ?? []).match(/\[(-?[\d.e+-]+,){2}-?[\d.e+-]+\]/) !== null;

function coordsEqual(a, b, tol) {
  if (a.length !== b.length) return false;
  return a.every((value, k) => Math.abs(value - b[k]) <= tol || (Number.isNaN(value) && Number.isNaN(b[k])));
}

function listEqual(a, b, tol) {
  return a.length === b.length && a.every((p, k) => coordsEqual(p, b[k], tol));
}

/** Ring equality, optionally regardless of start vertex and/or direction. */
function ringEqual(a, b, tol, ignore) {
  if (listEqual(a, b, tol)) return true;
  if (a.length !== b.length || a.length < 4) return false;
  const open = (r) => r.slice(0, -1);
  const rotations = (r) =>
    ignore.includes("ringStart") ? open(r).map((_, k) => [...open(r).slice(k), ...open(r).slice(0, k)]) : [open(r)];
  const candidates = [open(b), ...(ignore.includes("orientation") ? [open([...b].reverse())] : [])];
  for (const rotated of rotations(a)) {
    for (const candidate of candidates) if (listEqual(rotated, candidate, tol)) return true;
  }
  return false;
}

function polygonEqual(a, b, tol, ignore) {
  return a.length === b.length && a.every((ring, k) => ringEqual(ring, b[k], tol, ignore));
}

function partsEqual(type, a, b, tol, ignore) {
  switch (type) {
    case "POINT":
      return coordsEqual(a, b, tol);
    case "LINESTRING":
      return listEqual(a, b, tol) || (ignore.includes("orientation") && listEqual(a, [...b].reverse(), tol));
    case "POLYGON":
      return polygonEqual(a, b, tol, ignore);
    case "MULTIPOINT":
    case "MULTILINESTRING":
    case "MULTIPOLYGON":
    case "GEOMETRYCOLLECTION": {
      if (a.length !== b.length) return false;
      const single = { MULTIPOINT: "POINT", MULTILINESTRING: "LINESTRING", MULTIPOLYGON: "POLYGON" }[type];
      const eq = (x, y) =>
        single ? partsEqual(single, x, y, tol, ignore) : geometryDiff(x, y, { tolerance: tol, ignore }) === null;
      if (!ignore.includes("partOrder")) return a.every((part, k) => eq(part, b[k]));
      const left = [...b];
      return a.every((part) => {
        const at = left.findIndex((other) => eq(part, other));
        if (at < 0) return false;
        left.splice(at, 1);
        return true;
      });
    }
    default:
      return false;
  }
}

/** Why two parsed geometries differ in exact mode, or null. */
function geometryDiff(a, b, { tolerance, ignore }) {
  if (a.type !== b.type) return `type ${a.type} ≠ ${b.type}`;
  if (Boolean(a.empty) !== Boolean(b.empty)) return "one is empty";
  if (a.empty) return null;
  if (hasZ(a) !== hasZ(b)) return `dimensions ${hasZ(a) ? "XYZ" : "XY"} ≠ ${hasZ(b) ? "XYZ" : "XY"}`;
  return partsEqual(a.type, a.parts, b.parts, tolerance, ignore) ? null : "coordinates differ";
}

/**
 * Compare two WKT strings. Returns null when they match, or a reason.
 * @param {string|null} actual
 * @param {string|null} expected
 */
export function compareGeometry(actual, expected, options = {}) {
  const opts = { ...DEFAULT_GEOMETRY, ...options, ignore: options.ignore || [] };
  if (actual == null || expected == null) return actual == expected ? null : `${actual} ≠ ${expected}`;
  const a = parseWkt(actual);
  const b = parseWkt(expected);
  if (opts.mode === "exact") {
    const diff = geometryDiff(a, b, opts);
    return diff ? `${diff}: ${actual} vs ${expected}` : null;
  }
  if (a.type !== b.type) return `type ${a.type} ≠ ${b.type}: ${actual} vs ${expected}`;
  if (Boolean(a.empty) !== Boolean(b.empty)) return `one is empty: ${actual} vs ${expected}`;
  if (a.empty) return null;
  if (hasZ(a) !== hasZ(b)) return `dimensions differ: ${actual} vs ${expected}`;
  const ga = reader.read(actual);
  const gb = reader.read(expected);
  if (ga.isValid() !== gb.isValid()) return `validity differs: ${actual} vs ${expected}`;
  const dim = gb.getDimension();
  const areaOf = (g) => (dim === 2 ? g.getArea() : g.buffer(opts.tolerance).getArea());
  const reference = Math.max(areaOf(gb), 1e-30);
  const sym =
    dim === 2
      ? ga.symDifference(gb).getArea()
      : ga.buffer(opts.tolerance).symDifference(gb.buffer(opts.tolerance)).getArea();
  if (dim > 0 && sym > opts.areaTolerance * reference) {
    return `shapes differ (symmetric difference ${sym} > ${opts.areaTolerance} × ${reference}): ${actual} vs ${expected}`;
  }
  const hausdorff = DiscreteHausdorffDistance.distance(ga, gb);
  if (hausdorff > opts.tolerance)
    return `Hausdorff distance ${hausdorff} > ${opts.tolerance}: ${actual} vs ${expected}`;
  return null;
}

function valueEqual(a, b, type, geometry) {
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (type === "GEOMETRY") return compareGeometry(a, b, geometry) === null;
  if (typeof a === "number" && typeof b === "number") {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare one port's actual table with its expectation.
 * @param {{columns: {name:string,type:string}[], rows: any[][]}} actual
 * @param {{columns: {name:string,type:string}[], rows: any[][]}} expected
 * @returns {string[]} problems (empty when equal)
 */
export function compareTable(actual, expected, { ordered = false, geometry = {} } = {}) {
  const problems = [];
  const names = (cols) => cols.map((c) => `${c.name} ${c.type}`).join(", ");
  if (names(actual.columns) !== names(expected.columns)) {
    problems.push(`columns differ:\n    actual:   ${names(actual.columns)}\n    expected: ${names(expected.columns)}`);
    return problems;
  }
  const types = expected.columns.map((c) => c.type);
  const rowEqual = (x, y) => x.length === y.length && x.every((cell, k) => valueEqual(cell, y[k], types[k], geometry));
  if (actual.rows.length !== expected.rows.length) {
    problems.push(`${actual.rows.length} rows, expected ${expected.rows.length}`);
  }
  if (ordered) {
    expected.rows.forEach((row, k) => {
      if (actual.rows[k] && !rowEqual(actual.rows[k], row)) {
        problems.push(`row ${k}: ${JSON.stringify(actual.rows[k])} ≠ ${JSON.stringify(row)}`);
      }
    });
    return problems;
  }
  const left = [...actual.rows];
  for (const row of expected.rows) {
    const at = left.findIndex((candidate) => rowEqual(candidate, row));
    if (at < 0) problems.push(`missing row ${JSON.stringify(row)}`);
    else left.splice(at, 1);
  }
  for (const row of left) problems.push(`unexpected row ${JSON.stringify(row)}`);
  return problems;
}

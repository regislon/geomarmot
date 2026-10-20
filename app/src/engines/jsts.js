/*
 * Shapes DuckDB's spatial extension cannot make: the minimum rotated bounding box, the minimum bounding
 * circle, densifying and smoothing. JSTS (the JavaScript port of JTS) is loaded on first use. The overlay
 * behind AreaOnAreaOverlayer runs on GEOS instead (engines/geos/).
 */

import { mainEngine, qlit } from "../core/duck.js";

let jstsPromise = null;

async function loadJsts() {
  if (!jstsPromise) {
    // UMD: depending on how it is bundled it either defines a global or
    // exports the namespace, so accept both.
    jstsPromise = import("jsts/dist/jsts.min.js").then((module) => {
      const jsts = globalThis.jsts || module.default || module;
      if (!jsts?.operation?.polygonize?.Polygonizer) throw new Error("The geometry library did not load.");
      return jsts;
    });
  }
  return jstsPromise;
}

let reportProgress = null;

/** Where a long reshaping announces itself; the app points this at the status line. */
export function setShapeProgress(fn) {
  reportProgress = fn;
}

/**
 * Shapes DuckDB cannot make, one feature at a time.
 *
 * A rotated bounding box, a bounding circle, a densified line, a smoothed
 * outline: each is a JTS call with no DuckDB equivalent, and each is per
 * feature — so one helper takes the rows out, maps them, and puts them back as
 * a `fid -> geometry` table to join on.
 */
export const JS_GEOMETRY_OPS = {
  // The smallest rectangle at any angle, unlike ST_Envelope's axis-aligned one.
  MinimumBoundingBox: (jsts, geometry) => jsts.algorithm.MinimumDiameter.getMinimumRectangle(geometry),
  // The smallest enclosing circle, as a polygon.
  MinimumBoundingCircle: (jsts, geometry) => new jsts.algorithm.MinimumBoundingCircle(geometry).getCircle(),
  // Extra vertices so no segment is longer than the tolerance. Straight lines
  // in lon/lat are not straight on the ground, and this is what fixes that
  // before a reprojection.
  DensifyFeatures: (jsts, geometry, options) => jsts.densify.Densifier.densify(geometry, options.tolerance),
  // Chaikin corner cutting: each pass replaces every corner with two points a
  // quarter and three quarters along, which converges on a quadratic B-spline.
  // JTS has no smoother, and Chaikin is four lines.
  SmoothVectors: (jsts, geometry, options) => chaikin(jsts, geometry, options.iterations),
};

/** One Chaikin pass over every ring and line in a geometry. */
function chaikinCoordinates(coordinates, closed) {
  const output = [];
  const last = closed ? coordinates.length - 1 : coordinates.length - 1;
  if (!closed) output.push(coordinates[0]);
  for (let i = 0; i < last; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];
    output.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    output.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  if (!closed) output.push(coordinates[coordinates.length - 1]);
  else output.push(output[0]);
  return output;
}

function chaikin(jsts, geometry, iterations) {
  const factory = geometry.getFactory();
  const smoothRing = (ring, closed) => {
    let coordinates = ring.getCoordinates().map((c) => ({ x: c.x, y: c.y }));
    for (let pass = 0; pass < iterations; pass++) {
      // Four points is the least a ring can have; smoothing past that collapses
      // it, so it is left alone rather than destroyed.
      if (coordinates.length < 4) break;
      coordinates = chaikinCoordinates(coordinates, closed);
    }
    return coordinates.map((c) => new jsts.geom.Coordinate(c.x, c.y));
  };

  const type = geometry.getGeometryType();
  if (type === "Polygon") {
    const shell = factory.createLinearRing(smoothRing(geometry.getExteriorRing(), true));
    const holes = [];
    for (let i = 0; i < geometry.getNumInteriorRing(); i++) {
      holes.push(factory.createLinearRing(smoothRing(geometry.getInteriorRingN(i), true)));
    }
    return factory.createPolygon(shell, holes);
  }
  if (type === "LineString") return factory.createLineString(smoothRing(geometry, false));
  if (type.startsWith("Multi") || type === "GeometryCollection") {
    const parts = [];
    for (let i = 0; i < geometry.getNumGeometries(); i++) {
      parts.push(chaikin(jsts, geometry.getGeometryN(i), iterations));
    }
    return factory.buildGeometry(parts);
  }
  return geometry;
}

/**
 * Run one of those ops over `{fid, wkt}` rows into a `fid -> geometry` table.
 *
 * A row JTS refuses is passed through unchanged rather than dropped: losing a
 * feature silently because its geometry was awkward is worse than leaving it
 * unsmoothed.
 */
export async function createShapeTable(rows, opName, options, tableName, engine = mainEngine) {
  const jsts = await loadJsts();
  const op = JS_GEOMETRY_OPS[opName];
  if (!op) throw new Error(`Unknown geometry operation ${opName}.`);
  const reader = new jsts.io.WKTReader();
  const writer = new jsts.io.WKTWriter();

  await engine.exec(`CREATE OR REPLACE TABLE ${tableName} (fid BIGINT, geometry GEOMETRY)`);
  const encoder = new TextEncoder();
  const CHUNK = 5_000;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const lines = [];
    for (const row of rows.slice(start, start + CHUNK)) {
      let wkt = row.wkt;
      try {
        wkt = writer.write(op(jsts, reader.read(row.wkt), options));
      } catch {
        /* keep the original */
      }
      lines.push(JSON.stringify({ fid: row.fid, wkt }));
    }
    const jsonName = `${tableName}_${start}.json`;
    await engine.registerFileBuffer(jsonName, encoder.encode(lines.join("\n")));
    try {
      await engine.exec(
        `INSERT INTO ${tableName} SELECT fid, ST_GeomFromText(wkt) FROM read_json_auto(${qlit(jsonName)})`,
      );
    } finally {
      await engine.dropFile(jsonName);
    }
    if (rows.length > CHUNK) {
      reportProgress?.(
        `Reshaping… ${Math.min(start + CHUNK, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`,
      );
    }
  }
  return tableName;
}

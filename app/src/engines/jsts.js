/*
 * Planar partition, for AreaOnAreaOverlayer.
 *
 * The algorithm: union every polygon's boundary — that nodes them — polygonize the
 * result into atomic faces, then ask which input features cover each face.
 * Faces tile the union of the inputs exactly, so overlap counts are right
 * however many polygons meet at a point.
 *
 * It runs in JavaScript because DuckDB-WASM's spatial extension has neither
 * ST_Node nor ST_Polygonize. JSTS is JTS — the same library GEOS is a port of,
 * so the same algorithm Shapely runs.
 *
 * The alternative, intersecting polygons pairwise, is not equivalent: a region
 * covered by three polygons appears in three pairs, so its overlap count comes
 * out wrong and its area is counted three times. That is the whole reason this
 * pulls in a geometry library rather than staying in SQL.
 */

import { db, exec, qlit } from "../core/duck.js";

/**
 * Ceiling on input features.
 *
 * Noding is superlinear in the number of edges, and it happens on the main
 * thread — so this refuses early and says so, rather than freezing the tab
 * somewhere no message can reach.
 */
export const MAX_OVERLAY_FEATURES = 20_000;

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

/** Where a long partition announces itself; the app points this at the status line. */
export function setOverlayProgress(fn) {
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
export async function createShapeTable(rows, opName, options, tableName) {
  const jsts = await loadJsts();
  const op = JS_GEOMETRY_OPS[opName];
  if (!op) throw new Error(`Unknown geometry operation ${opName}.`);
  const reader = new jsts.io.WKTReader();
  const writer = new jsts.io.WKTWriter();

  await exec(`CREATE OR REPLACE TABLE ${tableName} (fid BIGINT, geometry GEOMETRY)`);
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
    await db().registerFileBuffer(jsonName, encoder.encode(lines.join("\n")));
    try {
      await exec(`INSERT INTO ${tableName} SELECT fid, ST_GeomFromText(wkt) FROM read_json_auto(${qlit(jsonName)})`);
    } finally {
      await db().dropFile(jsonName);
    }
    if (rows.length > CHUNK) {
      reportProgress?.(
        `Reshaping… ${Math.min(start + CHUNK, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`,
      );
    }
  }
  return tableName;
}

/**
 * Build the `face -> geometry, interior point` table for a set of WKT polygons.
 *
 * The interior point is what the caller joins on: a point guaranteed to be
 * inside its own face, so testing it against the inputs says exactly which of
 * them cover that face. A centroid would not do — the centroid of a crescent
 * lies outside it.
 */
export async function createFaceTable(wkts, tableName) {
  const jsts = await loadJsts();
  const reader = new jsts.io.WKTReader();
  const writer = new jsts.io.WKTWriter();

  reportProgress?.(`Noding ${wkts.length.toLocaleString()} polygons…`);
  let noded = null;
  for (const wkt of wkts) {
    let geometry;
    try {
      geometry = reader.read(wkt);
    } catch {
      continue; // A geometry JTS will not parse is skipped, not fatal.
    }
    const boundary = geometry.getBoundary();
    noded = noded ? noded.union(boundary) : boundary;
    // The union is the expensive half; yielding keeps the page answering.
    if (wkts.length > 500) await Promise.resolve();
  }
  if (!noded) throw new Error("No polygons to overlay.");

  reportProgress?.("Building faces…");
  const polygonizer = new jsts.operation.polygonize.Polygonizer();
  polygonizer.add(noded);
  const faces = polygonizer.getPolygons().toArray();

  await exec(`CREATE OR REPLACE TABLE ${tableName} (face_id BIGINT, geometry GEOMETRY, point GEOMETRY)`);
  const encoder = new TextEncoder();
  const CHUNK = 5_000;
  for (let start = 0; start < faces.length; start += CHUNK) {
    const lines = faces
      .slice(start, start + CHUNK)
      .map((face, offset) =>
        JSON.stringify({
          face_id: start + offset,
          wkt: writer.write(face),
          point: writer.write(face.getInteriorPoint()),
        }),
      )
      .join("\n");
    const jsonName = `${tableName}_${start}.json`;
    await db().registerFileBuffer(jsonName, encoder.encode(lines));
    try {
      await exec(
        `INSERT INTO ${tableName}
         SELECT face_id, ST_GeomFromText(wkt), ST_GeomFromText(point)
         FROM read_json_auto(${qlit(jsonName)})`,
      );
    } finally {
      await db().dropFile(jsonName);
    }
    if (faces.length > CHUNK) {
      reportProgress?.(
        `Writing faces… ${Math.min(start + CHUNK, faces.length).toLocaleString()} of ${faces.length.toLocaleString()}`,
      );
    }
  }
  return faces.length;
}

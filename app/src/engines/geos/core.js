// @ts-check
/*
 * The overlay core on GEOS (WebAssembly): a flat partition of a set of polygon parts, with the parts
 * covering each face.
 *
 * 1. Noding: the union of every part's boundary (GEOS OverlayNG floating noding).
 * 2. Faces: polygonize the noded lines.
 * 3. Provenance: one interior point per face, certified to lie more than `tau` from the face's boundary,
 *    then the parts that properly contain it. A face where no such point is found is ambiguous: its
 *    covering parts are left empty, never guessed. JSTS's getInteriorPoint has no such check, so a sliver
 *    face can be matched to the wrong polygon there.
 *
 * Interior points, cheapest first: point on surface; for faces whose point is too close to the boundary,
 * the incentre of the face's widest constrained-Delaunay triangle; only if still too close, the maximum
 * inscribed circle at tolerance tau/10. Faces narrower than 2·tau skip the last two steps: no interior
 * point of theirs can be further than tau from the boundary.
 *
 * Every GEOS object and malloc'd buffer is freed in a finally block: the WebAssembly heap never shrinks,
 * so a leak would grow it overlay after overlay.
 */

const POLYLABEL_TOLERANCE_FRACTION = 0.1;
const GEOS_POLYGON = 3;
const GEOS_GEOMETRYCOLLECTION = 7;
const PTR_BYTES = 4;
const F64_BYTES = 8;

/**
 * @typedef {object} OverlayResult
 * @property {Uint8Array[]} faces   WKB of each face
 * @property {Float64Array} areas   planar area of each face
 * @property {Float64Array} bounds  minx, miny, maxx, maxy of each face, flattened
 * @property {Int32Array} offsets   CSR offsets into `members`, one more than the number of faces
 * @property {Int32Array} members   indices of the parts covering each face (empty for ambiguous faces)
 * @property {Float64Array} clearance  distance from each face's interior point to its boundary
 * @property {Uint8Array} ambiguous 1 where no interior point lies more than tau from the boundary
 * @property {{ nodingMs: number, classifyMs: number, fallbackFaces: number, circleFaces: number }} stats
 */

/**
 * Overlay `parts` (WKB polygons) into faces carrying the parts that cover them.
 *
 * @param {any} geos  an initialised geos-wasm instance
 * @param {Uint8Array[]} partsWkb
 * @param {number} tau  clearance tolerance, in the parts' coordinate units
 * @returns {OverlayResult}
 */
export function overlayParts(geos, partsWkb, tau) {
  const io = makeIo(geos);
  const parts = [];
  let faces = 0;
  try {
    for (const wkb of partsWkb) parts.push(io.read(wkb));
    const t0 = performance.now();
    faces = nodeFaces(geos, parts);
    const t1 = performance.now();
    const n = geos.GEOSGetNumGeometries(faces);
    const faceGeoms = Array.from({ length: n }, (_, i) => geos.GEOSGetGeometryN(faces, i)); // owned by `faces`
    const { points, clearance, fallbackFaces, circleFaces } = interiorPoints(geos, faceGeoms, tau);
    try {
      const ambiguous = Uint8Array.from(clearance, (c) => (c <= tau ? 1 : 0));
      const { offsets, members } = containment(geos, parts, points, ambiguous);
      return {
        faces: faceGeoms.map(io.write),
        areas: Float64Array.from(faceGeoms, (g) => scalar(geos, "GEOSArea", g)),
        bounds: Float64Array.from(faceGeoms.flatMap((g) => envelope(geos, g))),
        offsets,
        members,
        clearance,
        ambiguous,
        stats: { nodingMs: t1 - t0, classifyMs: performance.now() - t1, fallbackFaces, circleFaces },
      };
    } finally {
      points.forEach((p) => geos.GEOSGeom_destroy(p));
    }
  } finally {
    if (faces) geos.GEOSGeom_destroy(faces);
    parts.forEach((p) => geos.GEOSGeom_destroy(p));
    io.destroy();
  }
}

/** WKB reader and writer bound to one GEOS instance. */
function makeIo(geos) {
  const M = geos.Module;
  const reader = geos.GEOSWKBReader_create();
  const writer = geos.GEOSWKBWriter_create();
  /** @param {Uint8Array} bytes */
  const read = (bytes) => {
    const ptr = M._malloc(bytes.length);
    try {
      M.HEAPU8.set(bytes, ptr);
      const g = geos.GEOSWKBReader_read(reader, ptr, bytes.length);
      if (!g) throw new Error("A geometry could not be read as WKB.");
      return g;
    } finally {
      M._free(ptr);
    }
  };
  /** @param {number} g */
  const write = (g) => {
    const sizePtr = M._malloc(F64_BYTES);
    try {
      const out = geos.GEOSWKBWriter_write(writer, g, sizePtr);
      const bytes = M.HEAPU8.slice(out, out + M.getValue(sizePtr, "i32"));
      geos.GEOSFree(out);
      return bytes;
    } finally {
      M._free(sizePtr);
    }
  };
  const destroy = () => {
    geos.GEOSWKBReader_destroy(reader);
    geos.GEOSWKBWriter_destroy(writer);
  };
  return { read, write, destroy };
}

/** A GEOS function that writes one double through an out-pointer (area, length, distance). */
function scalar(geos, fn, ...geoms) {
  const M = geos.Module;
  const p = M._malloc(F64_BYTES);
  try {
    geos[fn](...geoms, p);
    return M.getValue(p, "double");
  } finally {
    M._free(p);
  }
}

/** Faces of the arrangement: polygonize the union of every boundary. */
function nodeFaces(geos, parts) {
  const M = geos.Module;
  const arr = M._malloc(PTR_BYTES * Math.max(parts.length, 1));
  const one = M._malloc(PTR_BYTES);
  let collection = 0;
  let noded = 0;
  try {
    parts.forEach((g, i) => M.setValue(arr + PTR_BYTES * i, geos.GEOSBoundary(g), "i32"));
    collection = geos.GEOSGeom_createCollection(GEOS_GEOMETRYCOLLECTION, arr, parts.length); // takes ownership
    noded = geos.GEOSUnaryUnion(collection);
    M.setValue(one, noded, "i32");
    return geos.GEOSPolygonize(one, 1);
  } finally {
    M._free(arr);
    M._free(one);
    if (collection) geos.GEOSGeom_destroy(collection);
    if (noded) geos.GEOSGeom_destroy(noded);
  }
}

/** Interior point and its clearance for every face (see the header for the order of methods). */
function interiorPoints(geos, faces, tau) {
  const points = [];
  const clearance = new Float64Array(faces.length);
  let fallbackFaces = 0;
  let circleFaces = 0;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const boundary = geos.GEOSBoundary(face);
    try {
      let point = geos.GEOSPointOnSurface(face);
      let c = scalar(geos, "GEOSDistance", point, boundary);
      if (c <= tau && minWidth(geos, face) > 2 * tau) {
        fallbackFaces++;
        const incentre = widestIncentre(geos, face);
        if (incentre) {
          const ci = scalar(geos, "GEOSDistance", incentre, boundary);
          if (ci > c) {
            geos.GEOSGeom_destroy(point);
            [point, c] = [incentre, ci];
          } else geos.GEOSGeom_destroy(incentre);
        }
        if (c <= tau) {
          circleFaces++;
          const circle = geos.GEOSMaximumInscribedCircle(face, tau * POLYLABEL_TOLERANCE_FRACTION);
          try {
            geos.GEOSGeom_destroy(point);
            point = geos.GEOSGeomGetStartPoint(circle);
            c = scalar(geos, "GEOSLength", circle);
          } finally {
            geos.GEOSGeom_destroy(circle);
          }
        }
      }
      points.push(point);
      clearance[i] = c;
    } finally {
      geos.GEOSGeom_destroy(boundary);
    }
  }
  return { points, clearance, fallbackFaces, circleFaces };
}

/** Short side of the face's minimum rotated rectangle (0 when the rectangle degenerates). */
function minWidth(geos, face) {
  const rect = geos.GEOSMinimumRotatedRectangle(face);
  try {
    if (geos.GEOSGeomTypeId(rect) !== GEOS_POLYGON) return 0;
    const [a, b, c] = ringXY(geos, geos.GEOSGetExteriorRing(rect), 3);
    return Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
  } finally {
    geos.GEOSGeom_destroy(rect);
  }
}

/** The first `count` coordinates of a ring (owned by its polygon). */
function ringXY(geos, ring, count) {
  const M = geos.Module;
  const seq = geos.GEOSGeom_getCoordSeq(ring);
  const xy = M._malloc(2 * F64_BYTES);
  try {
    return Array.from({ length: count }, (_, i) => {
      geos.GEOSCoordSeq_getXY(seq, i, xy, xy + F64_BYTES);
      return [M.getValue(xy, "double"), M.getValue(xy + F64_BYTES, "double")];
    });
  } finally {
    M._free(xy);
  }
}

/** Incentre of the face's constrained-Delaunay triangle with the largest inradius, or 0 if none. */
function widestIncentre(geos, face) {
  const tris = geos.GEOSConstrainedDelaunayTriangulation(face);
  try {
    let best = null;
    let bestRadius = -1;
    for (let i = 0, n = geos.GEOSGetNumGeometries(tris); i < n; i++) {
      const [p, q, r] = ringXY(geos, geos.GEOSGetExteriorRing(geos.GEOSGetGeometryN(tris, i)), 3);
      const a = Math.hypot(q[0] - r[0], q[1] - r[1]);
      const b = Math.hypot(r[0] - p[0], r[1] - p[1]);
      const e = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const perimeter = a + b + e;
      if (perimeter <= 0) continue;
      const area = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
      const radius = (2 * area) / perimeter;
      if (radius > bestRadius) {
        bestRadius = radius;
        best = [(a * p[0] + b * q[0] + e * r[0]) / perimeter, (a * p[1] + b * q[1] + e * r[1]) / perimeter];
      }
    }
    return best ? geos.GEOSGeom_createPointFromXY(best[0], best[1]) : 0;
  } finally {
    geos.GEOSGeom_destroy(tris);
  }
}

/**
 * (face, part) pairs where the face's certified interior point lies in the part's interior.
 *
 * Each part is prepared once and tested against the points inside its envelope; points are sorted by x
 * so each part scans only its x range. Ambiguous faces get no parts.
 */
function containment(geos, parts, points, ambiguous) {
  const xy = points.map((p) => [scalar(geos, "GEOSGeomGetX", p), scalar(geos, "GEOSGeomGetY", p)]);
  const order = xy.map((_, i) => i).filter((i) => !ambiguous[i]);
  order.sort((i, j) => xy[i][0] - xy[j][0]);
  const xs = order.map((i) => xy[i][0]);
  /** @type {number[][]} */
  const byFace = points.map(() => []);
  parts.forEach((part, k) => {
    const [xmin, ymin, xmax, ymax] = envelope(geos, part);
    const prepared = geos.GEOSPrepare(part);
    try {
      for (let s = lowerBound(xs, xmin); s < xs.length && xs[s] <= xmax; s++) {
        const i = order[s];
        if (xy[i][1] < ymin || xy[i][1] > ymax) continue;
        if (geos.GEOSPreparedContainsProperly(prepared, points[i]) === 1) byFace[i].push(k);
      }
    } finally {
      geos.GEOSPreparedGeom_destroy(prepared);
    }
  });
  const offsets = new Int32Array(points.length + 1);
  byFace.forEach((m, i) => (offsets[i + 1] = offsets[i] + m.length));
  return { offsets, members: Int32Array.from(byFace.flat()) };
}

/** minx, miny, maxx, maxy of a geometry. */
function envelope(geos, g) {
  return ["getXMin", "getYMin", "getXMax", "getYMax"].map((f) => scalar(geos, `GEOSGeom_${f}`, g));
}

/** First index whose value is >= x in a sorted array. */
function lowerBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

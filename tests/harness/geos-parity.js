// @ts-check
/*
 * Parity of the GEOS overlay core against expected partitions (tests/fixtures/geos-overlay-parity.json).
 *
 * The expected file holds, per case, the input parts as WKT, the face count and, for every set of covering
 * parts, the union of its faces. A run matches when it has the same face count, no ambiguous face, the same
 * member sets, and each member set's faces differ from the expected union by at most 1e-12 in area.
 * Shared by the Node unit test and the Chromium suite, so both engines are held to the same rule.
 */

const MAX_SYMDIFF_AREA = 1e-12;
const F64_BYTES = 8;

/** WKT -> WKB through GEOS, so test inputs stay readable text. */
export function wktToWkb(geos, wkt) {
  const M = geos.Module;
  const reader = geos.GEOSWKTReader_create();
  const writer = geos.GEOSWKBWriter_create();
  const size = new TextEncoder().encode(wkt).length + 1;
  const text = M._malloc(size);
  const sizePtr = M._malloc(F64_BYTES);
  let g = 0;
  try {
    M.stringToUTF8(wkt, text, size);
    g = geos.GEOSWKTReader_read(reader, text);
    const out = geos.GEOSWKBWriter_write(writer, g, sizePtr);
    const bytes = M.HEAPU8.slice(out, out + M.getValue(sizePtr, "i32"));
    geos.GEOSFree(out);
    return bytes;
  } finally {
    if (g) geos.GEOSGeom_destroy(g);
    M._free(text);
    M._free(sizePtr);
    geos.GEOSWKTReader_destroy(reader);
    geos.GEOSWKBWriter_destroy(writer);
  }
}

/**
 * @param {any} geos
 * @param {{ faces: Uint8Array[], offsets: Int32Array, members: Int32Array, ambiguous: Uint8Array }} result
 * @param {{ faceCount: number, groups: { members: number[], wkt: string }[] }} expected
 * @returns {string[]} problems; empty when the run matches
 */
export function compareToExpected(geos, result, expected) {
  const problems = [];
  if (result.faces.length !== expected.faceCount) {
    problems.push(`face count ${result.faces.length}, expected ${expected.faceCount}`);
  }
  const nAmbiguous = result.ambiguous.reduce((n, a) => n + a, 0);
  if (nAmbiguous) problems.push(`${nAmbiguous} ambiguous face(s)`);
  const groups = new Map();
  result.faces.forEach((wkb, i) => {
    const key = Array.from(result.members.subarray(result.offsets[i], result.offsets[i + 1]))
      .sort((a, b) => a - b)
      .join(",");
    if (key) groups.set(key, [...(groups.get(key) || []), wkb]);
  });
  const expectedKeys = new Set(expected.groups.map((g) => g.members.join(",")));
  for (const key of groups.keys()) if (!expectedKeys.has(key)) problems.push(`unexpected member set [${key}]`);
  for (const group of expected.groups) {
    const key = group.members.join(",");
    if (!groups.has(key)) {
      problems.push(`missing member set [${key}]`);
      continue;
    }
    const area = symDiffArea(geos, groups.get(key), wktToWkb(geos, group.wkt));
    if (!(area <= MAX_SYMDIFF_AREA)) problems.push(`member set [${key}]: symmetric difference ${area}`);
  }
  return problems;
}

/** Area of the symmetric difference between the union of `faces` and `expected`. */
function symDiffArea(geos, faces, expected) {
  const M = geos.Module;
  const reader = geos.GEOSWKBReader_create();
  const owned = [];
  const read = (bytes) => {
    const ptr = M._malloc(bytes.length);
    try {
      M.HEAPU8.set(bytes, ptr);
      const g = geos.GEOSWKBReader_read(reader, ptr, bytes.length);
      owned.push(g);
      return g;
    } finally {
      M._free(ptr);
    }
  };
  const areaPtr = M._malloc(F64_BYTES);
  try {
    let union = read(faces[0]);
    for (const wkb of faces.slice(1)) {
      union = geos.GEOSUnion(union, read(wkb));
      owned.push(union);
    }
    const diff = geos.GEOSSymDifference(union, read(expected));
    owned.push(diff);
    geos.GEOSArea(diff, areaPtr);
    return M.getValue(areaPtr, "double");
  } finally {
    owned.forEach((g) => geos.GEOSGeom_destroy(g));
    M._free(areaPtr);
    geos.GEOSWKBReader_destroy(reader);
  }
}

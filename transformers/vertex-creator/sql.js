// @ts-check
/*
 * The SQL VertexCreator compiles to. See README.md for the behaviour.
 */

import { qid, valueSql, findGeometryColumn, geometryExpression } from "../_kit/index.js";

/*
 * VertexCreator, compiled to one SQL view.
 *
 * Each feature's vertices are unpacked into a list of {x, y, z} structs, the
 * new vertex is appended, inserted or swapped in with list slicing, and the
 * result is written back out as WKT. WKT rather than ST_MakeLine because this
 * build's ST_MakeLine takes 2D points only and ST_Point3D returns a POINT_3D
 * that is not a GEOMETRY — text is the one constructor that carries Z.
 *
 * Every intermediate lives in a `_vc_`-prefixed column, stage by stage, so no
 * expression is written out twice, and all of them are dropped at the end.
 */

export const VERTEX_MODES = ["Add Point", "Replace with Point", "Insert Point at Index", "Replace Point at Index"];
export const VERTEX_Z_CONFLICT = ["Compute", "None (Drop Values)", "Custom Value"];

/** The attribute that carries a rejected feature's reason. */
export const REJECTION_COLUMN = "rejection_code";

/**
 * A coordinate or index parameter as SQL, or null when it is not filled in.
 *
 * An empty constant counts as not filled in: valueSql would make it '' and
 * TRY_CAST would make that NULL, which would send every row to <Rejected>
 * rather than say the field is empty.
 */
function vertexParamSql(spec, type) {
  if ((spec?.kind || "Value") === "Value" && String(spec?.value ?? "").trim() === "") return null;
  const sql = valueSql(spec);
  return sql ? `TRY_CAST(${sql} AS ${type})` : null;
}

/** One vertex of `geom` at 1-based position `i`, as {x, y, z}. */
function vertexAt(geom, i) {
  const point = `ST_PointN(${geom}, (${i})::INTEGER)`;
  return `{'x': ST_X(${point}), 'y': ST_Y(${point}), 'z': CASE WHEN ST_HasZ(${geom}) THEN ST_Z(${point}) END}`;
}

/**
 * The feature's vertices, by geometry type.
 *
 * A polygon contributes its exterior ring without the closing vertex, so an
 * index counts corners the way a person would and the ring is closed again on
 * the way out. `_vc_t` is 'NULL' for a missing or empty geometry, which is
 * treated as having no vertices at all.
 */
function vertexListSql() {
  const ring = "ST_ExteriorRing(_vc_g)";
  return (
    `CASE _vc_t ` +
    `WHEN 'POINT' THEN [{'x': ST_X(_vc_g), 'y': ST_Y(_vc_g), 'z': CASE WHEN ST_HasZ(_vc_g) THEN ST_Z(_vc_g) END}] ` +
    `WHEN 'LINESTRING' THEN list_transform(range(1, ST_NPoints(_vc_g) + 1), i -> ${vertexAt("_vc_g", "i")}) ` +
    `WHEN 'POLYGON' THEN list_transform(range(1, ST_NPoints(${ring})), i -> ${vertexAt(ring, "i")}) ` +
    `ELSE []::STRUCT(x DOUBLE, y DOUBLE, z DOUBLE)[] END`
  );
}

/**
 * Why a feature goes to <Rejected>, or NULL when it can be handled.
 *
 * Follows the table of modes by geometry type in the README. Arcs, clothoids and
 * B-splines do not exist in DuckDB, and a polygon with holes is rejected
 * rather than guessed at — an index into "the polygon" is ambiguous once it
 * has more than one ring.
 */
function vertexRejectionSql(mode) {
  const missing =
    `CASE WHEN _vc_x IS NULL OR _vc_y IS NULL THEN 'MISSING_COORDINATE' ` +
    (mode.endsWith("at Index") ? `WHEN _vc_i IS NULL THEN 'MISSING_INDEX' ` : "");
  if (mode === "Replace with Point") return `${missing}END`;
  if (mode === "Add Point") {
    return `${missing}WHEN _vc_t NOT IN ('NULL', 'POINT', 'LINESTRING') THEN 'UNSUPPORTED_GEOMETRY_TYPE' END`;
  }
  return (
    `${missing}WHEN _vc_t NOT IN ('NULL', 'POINT', 'LINESTRING', 'POLYGON') THEN 'UNSUPPORTED_GEOMETRY_TYPE' ` +
    `WHEN _vc_t = 'POLYGON' AND ST_NInteriorRings(_vc_g) > 0 THEN 'POLYGON_WITH_HOLES' END`
  );
}

/**
 * Where the new vertex lands, as a 1-based position in the list.
 *
 * The index rules: 0 is the first vertex, -1 the last, negatives count back
 * from the end, and out-of-range values clamp to the ends. For an insert the
 * position is the new vertex's own index afterwards, so -1 appends.
 */
function vertexPositionSql(mode) {
  if (mode === "Insert Point at Index") {
    return `CASE WHEN _vc_i >= 0 THEN least(_vc_i, _vc_n) ELSE greatest(0, _vc_n + 1 + _vc_i) END + 1`;
  }
  return `CASE WHEN _vc_i >= 0 THEN least(_vc_i, _vc_n - 1) ELSE greatest(0, _vc_n + _vc_i) END + 1`;
}

/**
 * The new vertex's Z when the input is 3D and no Z Value was given.
 *
 * Compute interpolates between the neighbours the vertex lands between, by
 * planar distance, and takes the one neighbour's value at an end. Add Point
 * first honours one exception: a 2D point on either endpoint takes that
 * endpoint's Z, whatever the conflict setting.
 */
function computedZSql(mode, conflict, custom) {
  const endpoint =
    mode === "Add Point"
      ? `WHEN _vc_n > 0 AND _vc_v[1].x = _vc_x AND _vc_v[1].y = _vc_y THEN _vc_v[1].z ` +
        `WHEN _vc_n > 0 AND _vc_v[_vc_n].x = _vc_x AND _vc_v[_vc_n].y = _vc_y THEN _vc_v[_vc_n].z `
      : "";
  // The endpoint rule only exists for Add Point; elsewhere this is just `fallback`.
  const orElse = (fallback) => (endpoint ? `CASE ${endpoint}ELSE ${fallback} END` : fallback);
  if (conflict === "Custom Value") return orElse(String(custom));
  if (conflict !== "Compute") return orElse("NULL");
  // An appended vertex has one neighbour, the old last vertex.
  if (mode === "Add Point") return orElse("_vc_v[_vc_n].z");
  // Otherwise, the neighbours either side of where the vertex will be.
  const [before, after] =
    mode === "Insert Point at Index" ? ["_vc_v[_vc_p - 1]", "_vc_v[_vc_p]"] : ["_vc_v[_vc_p - 1]", "_vc_v[_vc_p + 1]"];
  const dist = (a) => `sqrt(power(${a}.x - _vc_x, 2) + power(${a}.y - _vc_y, 2))`;
  const interpolated =
    `CASE WHEN ${before} IS NULL AND ${after} IS NULL THEN _vc_v[_vc_p].z ` +
    `WHEN ${after} IS NULL THEN ${before}.z WHEN ${before} IS NULL THEN ${after}.z ` +
    `WHEN ${dist(before)} + ${dist(after)} = 0 THEN (${before}.z + ${after}.z) / 2 ` +
    `ELSE ${before}.z + (${after}.z - ${before}.z) * ${dist(before)} / (${dist(before)} + ${dist(after)}) END`;
  return orElse(interpolated);
}

/** The vertex list after the edit. */
function editedListSql(mode, ignoreDuplicates) {
  const vertex = "{'x': _vc_x, 'y': _vc_y, 'z': _vc_nz}";
  if (mode === "Add Point") {
    const append = `list_append(_vc_v, ${vertex})`;
    if (!ignoreDuplicates) return append;
    return `CASE WHEN _vc_n > 0 AND _vc_v[_vc_n].x = _vc_x AND _vc_v[_vc_n].y = _vc_y THEN _vc_v ELSE ${append} END`;
  }
  const head = "_vc_v[1:_vc_p - 1]";
  if (mode === "Insert Point at Index") return `list_concat(list_concat(${head}, [${vertex}]), _vc_v[_vc_p:])`;
  return `CASE WHEN _vc_n = 0 THEN [${vertex}] ELSE list_concat(list_concat(${head}, [${vertex}]), _vc_v[_vc_p + 1:]) END`;
}

/**
 * The edited vertices as a geometry.
 *
 * One vertex is a point; a polygon stays a polygon, closed again; a line whose
 * ends now meet becomes a polygon when Closed Line Handling asks for one and
 * there are enough corners for an area. Missing Z values are filled from
 * `_vc_fill` — the new vertex's Z when Compute has only that one to go on, or
 * the custom value.
 */
function rebuiltGeometrySql(closedAsPolygon) {
  const coord = `p -> p.x::VARCHAR || ' ' || p.y::VARCHAR || CASE WHEN _vc_3d THEN ' ' || coalesce(p.z, _vc_fill, 0)::VARCHAR ELSE '' END`;
  const coords = `array_to_string(list_transform(_vc_e, ${coord}), ', ')`;
  const first = `list_transform([_vc_e[1]], ${coord})[1]`;
  const dims = `CASE WHEN _vc_3d THEN ' Z' ELSE '' END`;
  const closed = `(len(_vc_e) >= 4 AND _vc_e[1].x = _vc_e[-1].x AND _vc_e[1].y = _vc_e[-1].y)`;
  return (
    `ST_GeomFromText(CASE ` +
    `WHEN len(_vc_e) = 1 THEN 'POINT' || ${dims} || ' (' || ${coords} || ')' ` +
    `WHEN _vc_t = 'POLYGON' THEN 'POLYGON' || ${dims} || ' ((' || ${coords} || ', ' || ${first} || '))' ` +
    (closedAsPolygon ? `WHEN ${closed} THEN 'POLYGON' || ${dims} || ' ((' || ${coords} || '))' ` : "") +
    `ELSE 'LINESTRING' || ${dims} || ' (' || ${coords} || ')' END)`
  );
}

/** Columns the X/Y/Z Values read from, for Remove Attributes. */
function vertexSourceColumns(params, columns) {
  const names = new Set(columns.map((column) => column.name));
  return ["x", "y", "z"]
    .map((key) => params[key])
    .filter((spec) => spec?.kind === "Attribute" && spec.column && names.has(spec.column))
    .map((spec) => spec.column);
}

/** The two port queries for a VertexCreator node. */
export function vertexCreatorSql(params, input, columns) {
  const mode = params.mode || "Add Point";
  const conflict = params.zConflict || "Compute";
  const x = vertexParamSql(params.x, "DOUBLE");
  const y = vertexParamSql(params.y, "DOUBLE");
  if (!x || !y) throw new Error("Set an X Value and a Y Value.");
  const z = vertexParamSql(params.z, "DOUBLE") || "NULL::DOUBLE";
  const byIndex = mode.endsWith("at Index");
  const index = byIndex ? vertexParamSql(params.index, "BIGINT") : "NULL::BIGINT";
  if (byIndex && !index) throw new Error("Set the Index to insert at or replace.");
  const custom = Number(params.zCustom ?? 0);
  if (conflict === "Custom Value" && !Number.isFinite(custom)) throw new Error("The custom Z value must be a number.");

  const geometry = findGeometryColumn(columns);
  const column = qid(geometry?.name || "geometry");
  const source = geometry ? geometryExpression(geometry) : "NULL::GEOMETRY";
  const removed = params.removeAttributes === "Yes" ? vertexSourceColumns(params, columns) : [];
  const dropped = [
    "_vc_g",
    "_vc_t",
    "_vc_x",
    "_vc_y",
    "_vc_z",
    "_vc_i",
    "_vc_v",
    "_vc_n",
    "_vc_p",
    "_vc_r",
    "_vc_nz",
    "_vc_3d",
    "_vc_fill",
    "_vc_e",
  ];

  // Stage 1: the inputs, evaluated once.
  const stage1 =
    `SELECT *, ${source} AS _vc_g, ` +
    `CASE WHEN ${source} IS NULL OR ST_IsEmpty(${source}) THEN 'NULL' ELSE ST_GeometryType(${source})::VARCHAR END AS _vc_t, ` +
    `${x} AS _vc_x, ${y} AS _vc_y, ${z} AS _vc_z, ${index} AS _vc_i FROM ${input}`;
  // Stage 2: the vertices, and whether this row can be handled at all.
  const stage2 = `SELECT *, ${vertexListSql()} AS _vc_v, ${vertexRejectionSql(mode)} AS _vc_r FROM (${stage1})`;
  // Stage 3: how many there are, and where the new one goes.
  const position = byIndex ? vertexPositionSql(mode) : "NULL::BIGINT";
  const stage3 = `SELECT *, len(_vc_v) AS _vc_n, ${position.replaceAll("_vc_n", "len(_vc_v)")} AS _vc_p FROM (${stage2})`;
  // Stage 4: the Z story — whether the output is 3D, the new vertex's Z, and
  // what fills the existing vertices' Z when only the new one had any.
  const in3d = "coalesce(ST_HasZ(_vc_g), false)";
  const given = "_vc_z IS NOT NULL";
  // Replace with Point discards the input, so only the new vertex decides.
  const replacing = mode === "Replace with Point";
  const out3d = replacing
    ? given
    : conflict === "None (Drop Values)"
      ? `(${in3d} AND ${given})`
      : `(${in3d} OR ${given})`;
  const newZ = replacing
    ? "_vc_z"
    : `CASE WHEN ${given} THEN _vc_z WHEN ${in3d} THEN ${computedZSql(mode, conflict, custom)} ` +
      `ELSE ${conflict === "Custom Value" ? custom : "NULL"} END`;
  const fill = conflict === "Custom Value" ? String(custom) : conflict === "Compute" ? "_vc_z" : "NULL";
  const stage4 = `SELECT *, ${newZ} AS _vc_nz, ${out3d} AS _vc_3d, ${fill}::DOUBLE AS _vc_fill FROM (${stage3})`;
  // Stage 5: the edited vertex list — skipped for rejected rows, whose indexes
  // may not mean anything.
  const edited =
    mode === "Replace with Point"
      ? "[{'x': _vc_x, 'y': _vc_y, 'z': _vc_nz}]"
      : editedListSql(mode, (params.ignoreDuplicates || "Yes") === "Yes");
  const stage5 = `SELECT *, CASE WHEN _vc_r IS NULL THEN ${edited} END AS _vc_e FROM (${stage4})`;

  const closedAsPolygon = (params.closedLines || "Create Polygon") === "Create Polygon";
  const built = rebuiltGeometrySql(closedAsPolygon);
  const keepOut = [...dropped, ...removed, ...(geometry ? [geometry.name] : [])];
  // Rejected rows keep every attribute: they are the ones someone has to fix.
  const keepRejected = dropped;
  const exclude = (names) => [...new Set(names)].map(qid).join(", ");
  return {
    output: `SELECT * EXCLUDE (${exclude(keepOut)}), ${built} AS ${column} FROM (${stage5}) WHERE _vc_r IS NULL`,
    rejected:
      `SELECT * EXCLUDE (${exclude(keepRejected)}), _vc_r AS ${qid(REJECTION_COLUMN)} ` +
      `FROM (${stage5}) WHERE _vc_r IS NOT NULL`,
  };
}

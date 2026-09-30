/*
 * The transformer registry.
 *
 * Every transformer is a pure function from an upstream view name to SQL. That
 * is the whole execution model: a node becomes `CREATE OR REPLACE VIEW … AS
 * <sql>`, so nothing is computed until something asks to see it, and selecting
 * any node in the graph is just a SELECT against its view. Every node's output
 * is inspectable for free, because a view costs nothing until read.
 *
 * Adding a transformer means adding one entry here — ports, parameters and the
 * SQL it compiles to. Nothing else in the app needs to know it exists.
 */

import { exec, qid, qlit, query } from "../app/src/core/duck.js";
import { valueSql } from "../app/src/core/valuespec.js";
import { findGeometryColumn, geometryExpression, LONLAT } from "../app/src/core/schema.js";
import { createShapeTable } from "../app/src/engines/jsts.js";
import {
  FILL_MODES,
  H3_INDEX_COLUMN,
  MAX_MATERIALISED_CELLS,
  ROW_NUMBER_COLUMN,
  childResolutionFor,
  createCellGeometryTable,
  createPolygonFillTable,
  parseParentCell,
  positionalIndexExpr,
} from "../app/src/engines/h3/index.js";

/** Internal join key for PolygonToH3 and the overlayer; never leaves a node. */
const FEATURE_ID_COLUMN = "_pv_fid";

/** The Reprojector's destination, trimmed; blank means "not chosen yet". */
function destinationCrs(node) {
  return (node.params.to || "").trim();
}

/**
 * Move a geometry expression between coordinate systems, or leave it alone.
 *
 * always_xy is not optional. PROJ honours EPSG:4326's authority axis order,
 * which is latitude first, so without it every transformed point comes back
 * with its coordinates swapped.
 */
function toCrs(expression, from, to) {
  if (from === to) return expression;
  return `ST_Transform(${expression}, ${qlit(from)}, ${qlit(to)}, always_xy := true)`;
}

const SINGLE_OUT = [{ id: "output", label: "Output" }];
const SINGLE_IN = [{ id: "input", label: "Input" }];

/** Comparison operators offered by the Tester, and how each builds SQL. */
export const OPERATORS = {
  "=": (column, value) => `${column} = ${qlit(value)}`,
  "!=": (column, value) => `${column} <> ${qlit(value)}`,
  ">": (column, value) => `${column} > ${qlit(value)}`,
  ">=": (column, value) => `${column} >= ${qlit(value)}`,
  "<": (column, value) => `${column} < ${qlit(value)}`,
  "<=": (column, value) => `${column} <= ${qlit(value)}`,
  contains: (column, value) => `${column} LIKE ${qlit(`%${value}%`)}`,
  "starts with": (column, value) => `${column} LIKE ${qlit(`${value}%`)}`,
  "is null": (column) => `${column} IS NULL`,
  "is not null": (column) => `${column} IS NOT NULL`,
};

/* ---------- H3 helpers ---------- */

/**
 * The parent cell an H3 node works from: what the user typed, else the cell the
 * upstream Reader's file is named after.
 */
function resolveParent(node, ctx) {
  const typed = (node.params.parent || "").trim();
  if (typed) {
    const parsed = parseParentCell(typed);
    if (!parsed) throw new Error(`"${typed}" is not a valid H3 cell.`);
    return parsed;
  }
  const fromFile = ctx?.source?.h3?.parent || parseParentCell(ctx?.source?.name || "");
  if (!fromFile) {
    throw new Error("No parent cell — the file is not named after one, so type it in.");
  }
  return fromFile;
}

/**
 * The child resolution: what the user typed, else the one whose child count
 * equals the row count — the same integrity check the tile builder asserts.
 */
function resolveChildResolution(node, ctx, parent) {
  const typed = (node.params.resolution || "").trim();
  if (typed) {
    const value = Number(typed);
    if (!Number.isInteger(value) || value < 0 || value > 15) {
      throw new Error(`"${typed}" is not an H3 resolution (0-15).`);
    }
    return value;
  }
  const derived = childResolutionFor(parent, ctx?.rowCount ?? 0);
  if (derived === null) {
    throw new Error(
      `${(ctx?.rowCount ?? 0).toLocaleString()} rows is not a whole number of children of ${parent} — ` +
        "set the child resolution by hand.",
    );
  }
  return derived;
}

function positionalExprFor(node, ctx, qualifier = "") {
  const parent = resolveParent(node, ctx);
  const resolution = resolveChildResolution(node, ctx, parent);
  const rowRef = qualifier ? `${qualifier}.${qid(ROW_NUMBER_COLUMN)}` : qid(ROW_NUMBER_COLUMN);
  return positionalIndexExpr(parent, resolution, rowRef);
}

function cellTableName(node) {
  return `h3cells_${node.id}`;
}

/**
 * How many cells Auto aims to build.
 *
 * Deliberately well under the hard ceiling: the map draws 8,000 by default, so
 * building hundreds of thousands of hexagons to look at a tile buys nothing but
 * a slow rebuild. Ask for step 1 explicitly when you want every one.
 */
const AUTO_SAMPLE_TARGET = 50_000;

export const SAMPLE_STEPS = ["Auto", "All", "10", "100", "1000", "10000"];

/** Take every Nth cell: what the user chose, or enough to keep Auto comfortable. */
function sampleStep(node, ctx) {
  const chosen = node.params.sample || "Auto";
  if (chosen === "All") return 1;
  if (chosen !== "Auto") return Math.max(1, Number(chosen) || 1);
  const rows = ctx?.rowCount ?? 0;
  if (rows <= AUTO_SAMPLE_TARGET) return 1;
  const needed = Math.ceil(rows / AUTO_SAMPLE_TARGET);
  return [10, 100, 1000, 10_000, 100_000].find((step) => step >= needed) || 1_000_000;
}

/**
 * The sampling filter, applied identically when the cells are collected and
 * when they are joined back — otherwise the two disagree and rows come out
 * with no geometry.
 */
function sampleWhere(step, expression) {
  return step <= 1 ? "" : ` WHERE ${expression} % ${step} = 0`;
}

/**
 * Materialise the hexagons a geometry node needs.
 *
 * Runs in the node's `prepare` step, before its SQL is compiled, and reports
 * the table so the graph can drop it on the next rebuild.
 */
async function buildCellTable(node, selectSql) {
  const rows = await query(`${selectSql} LIMIT ${MAX_MATERIALISED_CELLS + 1}`);
  if (rows.length > MAX_MATERIALISED_CELLS) {
    throw new Error(
      `${MAX_MATERIALISED_CELLS.toLocaleString()} cells is the ceiling. ` + "Sample, or filter upstream.",
    );
  }
  const table = cellTableName(node);
  await createCellGeometryTable(rows.map((row) => row.cell).filter(Boolean), table);
  return { tables: [table] };
}

/**
 * A tool that replaces each feature's geometry with a function of it.
 *
 * Whitebox's geometry-processing toolbox is largely this shape — centroid,
 * representative point, convex hull, simplify — so it is written once. The
 * attributes ride along untouched; only the shape changes.
 */
function geometryTool({ label, hint, build, params = [], collapses = () => false }) {
  return {
    label,
    group: "Geometry",
    hint,
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    needsSchema: true,
    params,
    sql: (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error(`${label} needs a geometry column.`);
      const column = qid(geometry.name);
      const source = geometryExpression(geometry);
      const shaped = build(source, node.params, geometry);
      // Whether the tool collapses the layer can depend on its parameters — one
      // hull around everything is an aggregate, one hull per feature is not —
      // and an aggregate cannot sit beside `*` in the same SELECT.
      return {
        output: collapses(node.params)
          ? `SELECT ${shaped} AS ${column} FROM ${upstream.input}`
          : `SELECT * EXCLUDE (${column}), ${shaped} AS ${column} FROM ${upstream.input}`,
      };
    },
  };
}

/**
 * A geometry tool whose work happens in JTS rather than in SQL.
 *
 * Spreads into the registry as `{ [label]: node }` so the four declarations
 * above read as a list rather than as four copies of the same prepare/sql pair.
 * The rows are materialised with an id first, for the same reason PolygonToH3
 * does it: a row number computed on the fly is not promised to match between
 * the read and the join.
 */
function jsGeometryTool({ label, hint, params = [], options = () => ({}) }) {
  return {
    [label]: {
      label,
      group: "Geometry",
      hint,
      inputs: SINGLE_IN,
      outputs: () => SINGLE_OUT,
      needsSchema: true,
      params,
      prepare: async (node, upstream, ctx) => {
        const geometry = findGeometryColumn(ctx.schemas?.input || []);
        if (!geometry) throw new Error(`${label} needs a geometry column.`);
        const source = `${cellTableName(node)}_src`;
        const shapes = `${cellTableName(node)}_shape`;
        await exec(
          `CREATE OR REPLACE TABLE ${source} AS ` +
            `SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${upstream.input}`,
        );
        const rows = await query(
          `SELECT ${qid(FEATURE_ID_COLUMN)} AS fid, ST_AsText(${geometryExpression(geometry)}) AS wkt ` +
            `FROM ${source} WHERE ${qid(geometry.name)} IS NOT NULL`,
        );
        await createShapeTable(rows, label, options(node.params), shapes);
        return { tables: [source, shapes] };
      },
      sql: (node, upstream, ctx) => {
        const geometry = findGeometryColumn(ctx.schemas?.input || []);
        const source = `${cellTableName(node)}_src`;
        const shapes = `${cellTableName(node)}_shape`;
        const column = qid(geometry?.name || "geometry");
        // LEFT JOIN, so a row whose geometry was NULL upstream survives with a
        // NULL shape rather than vanishing from the output.
        return {
          output:
            `SELECT s.* EXCLUDE (${qid(FEATURE_ID_COLUMN)}, ${column}), g.geometry AS ${column} ` +
            `FROM ${source} s LEFT JOIN ${shapes} g ON s.${qid(FEATURE_ID_COLUMN)} = g.fid`,
        };
      },
    },
  };
}

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

const VERTEX_MODES = ["Add Point", "Replace with Point", "Insert Point at Index", "Replace Point at Index"];
const VERTEX_Z_CONFLICT = ["Compute", "None (Drop Values)", "Custom Value"];

/** The attribute that carries a rejected feature's reason. */
const REJECTION_COLUMN = "rejection_code";

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
function vertexCreatorSql(node, upstream, columns) {
  const params = node.params;
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
    `${x} AS _vc_x, ${y} AS _vc_y, ${z} AS _vc_z, ${index} AS _vc_i FROM ${upstream.input}`;
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

export const TRANSFORMERS = {
  /*
   * The H3 group.
   *
   * A "dense positional" tile is a file named after its parent
   * cell, holds all 7^n children of it in ascending order, and carries no cell
   * column — row i *is* sorted_children[i]. These three nodes turn that back
   * into an index and then into geometry.
   *
   * They are separate nodes, and in that order, because the two halves cost
   * wildly different amounts. The index is pure arithmetic on the row number:
   * lazy, free, and fine on all 823,543 rows. The geometry has to be built cell
   * by cell in JavaScript and materialised, which is only sane after a filter.
   * Splitting them puts that cost where you can see and control it.
   */
  PositionalH3Index: {
    label: "PositionalH3Index",
    needsLonLat: true,
    group: "H3",
    hint: "Derives the H3 index from row order. Needs the Reader's row number.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [
      { id: "parent", label: "Parent cell", kind: "string", placeholder: "from the file name" },
      { id: "resolution", label: "Child resolution", kind: "string", placeholder: "from the row count" },
    ],
    needsSchema: true,
    needsRowCount: true,
    sql: (node, upstream, ctx) => {
      const parent = resolveParent(node, ctx);
      const resolution = resolveChildResolution(node, ctx, parent);
      const columns = ctx.schemas?.input || [];
      if (!columns.some((column) => column.name === ROW_NUMBER_COLUMN)) {
        throw new Error(
          `No "${ROW_NUMBER_COLUMN}" column — set the Reader's "Row number" to Yes so the row order survives.`,
        );
      }
      const expr = positionalIndexExpr(parent, resolution, qid(ROW_NUMBER_COLUMN));
      return {
        output:
          `SELECT * EXCLUDE (${qid(ROW_NUMBER_COLUMN)}), ${expr} AS ${qid(H3_INDEX_COLUMN)} ` +
          `FROM ${upstream.input}`,
      };
    },
  },

  /*
   * Whitebox's Vector - Attribute Analysis toolbox, for the tools that are not
   * already here under another name. Add Field, Delete Field, Rename Field and
   * Field Calculator are AttributeCreator / Remover / Renamer, and Extract By
   * Attribute is the Tester; a second node doing the same job under a different
   * label would only make the palette harder to search.
   */

  /*
   * Whitebox's Add Geometry Attributes: measurements of the shape, as columns.
   *
   * Area and perimeter go through an equal-area projection rather than being
   * measured in degrees, which is the difference between hectares and a number
   * with no meaning. EPSG:6933 is within ~0.7% anywhere; the spheroid functions
   * on this DuckDB build are not (see the README).
   */
  AddGeometryAttributes: {
    label: "AddGeometryAttributes",
    group: "Analysis",
    hint: "Adds area, perimeter, vertex count and type as attributes.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    needsSchema: true,
    params: [
      {
        id: "measures",
        label: "Add",
        kind: "choices",
        choices: ["Area (ha)", "Perimeter (km)", "Vertices", "Geometry type", "Parts", "Centroid lon/lat"],
        default: ["Area (ha)", "Perimeter (km)", "Geometry type"],
      },
    ],
    sql: (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error("AddGeometryAttributes needs a geometry column.");
      const source = geometryExpression(geometry);
      // Equal-area metres, entered from whatever the stream is actually in
      // rather than from an assumption that it is still lon/lat.
      const metric = toCrs(source, ctx.crs, "EPSG:6933");
      const lonlat = toCrs(source, ctx.crs, LONLAT);
      const wanted = new Set(node.params.measures || []);
      const additions = [];
      if (wanted.has("Area (ha)")) additions.push(`ST_Area(${metric}) / 10000 AS area_ha`);
      if (wanted.has("Perimeter (km)")) additions.push(`ST_Perimeter(${metric}) / 1000 AS perimeter_km`);
      if (wanted.has("Vertices")) additions.push(`ST_NPoints(${source}) AS vertices`);
      if (wanted.has("Geometry type")) additions.push(`ST_GeometryType(${source}) AS geometry_type`);
      if (wanted.has("Parts")) additions.push(`ST_NumGeometries(${source}) AS parts`);
      if (wanted.has("Centroid lon/lat")) {
        additions.push(`ST_X(ST_Centroid(${lonlat})) AS centroid_lon`);
        additions.push(`ST_Y(ST_Centroid(${lonlat})) AS centroid_lat`);
      }
      if (!additions.length) return { output: `SELECT * FROM ${upstream.input}` };
      return { output: `SELECT *, ${additions.join(", ")} FROM ${upstream.input}` };
    },
  },

  /*
   * Whitebox's List Unique Values: what is in a column, and how often.
   *
   * A table rather than the HTML report Whitebox writes — a table is what the
   * rest of this app can carry onwards, filter and export.
   */
  ListUniqueValues: {
    label: "ListUniqueValues",
    group: "Analysis",
    hint: "One row per distinct value of an attribute, with its count.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [{ id: "column", label: "Attribute", kind: "column" }],
    sql: (node, upstream) => {
      if (!node.params.column) throw new Error("Choose an attribute to list.");
      const column = qid(node.params.column);
      return {
        output:
          `SELECT ${column} AS value, count(*) AS n, ` +
          `round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS percent ` +
          `FROM ${upstream.input} GROUP BY ${column} ORDER BY n DESC, 1`,
      };
    },
  },

  /*
   * Whitebox's Filter Vector Features By Area.
   *
   * The Tester could express this, but only once you know to write the
   * equal-area projection into the predicate yourself — which is exactly the
   * step people get wrong. Here the units are hectares and the projection is
   * not the user's problem.
   */
  FilterVectorFeaturesByArea: {
    label: "FilterVectorFeaturesByArea",
    group: "Analysis",
    hint: "Keeps features whose area falls between two bounds, in hectares.",
    inputs: SINGLE_IN,
    outputs: () => [
      { id: "kept", label: "Kept" },
      { id: "removed", label: "Removed" },
    ],
    needsSchema: true,
    params: [
      { id: "min", label: "Minimum area (ha)", kind: "string", default: "0" },
      { id: "max", label: "Maximum area (ha)", kind: "string", placeholder: "no limit" },
    ],
    sql: (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error("FilterVectorFeaturesByArea needs a geometry column.");
      const area = `ST_Area(${toCrs(geometryExpression(geometry), ctx.crs, "EPSG:6933")}) / 10000`;
      const min = Number(node.params.min ?? 0);
      const max = node.params.max?.trim() ? Number(node.params.max) : null;
      if (!Number.isFinite(min) || (max !== null && !Number.isFinite(max))) {
        throw new Error("Area bounds must be numbers of hectares.");
      }
      const test = [`${area} >= ${min}`, max === null ? null : `${area} <= ${max}`].filter(Boolean).join(" AND ");
      return {
        kept: `SELECT * FROM ${upstream.input} WHERE ${test}`,
        removed: `SELECT * FROM ${upstream.input} WHERE NOT (${test})`,
      };
    },
  },

  /*
   * Whitebox's Attribute Correlation: "Performs a correlation analysis on
   * attribute fields from a vector database."
   *
   * Whitebox writes an HTML matrix; this emits the matrix as rows, one per pair,
   * which is the form you can sort, filter and export. `corr` is DuckDB's
   * Pearson coefficient.
   */
  AttributeCorrelation: {
    label: "AttributeCorrelation",
    group: "Analysis",
    hint: "Pearson correlation between every pair of the chosen numeric attributes.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    needsSchema: true,
    params: [{ id: "columns", label: "Attributes", kind: "columns", filter: "numeric" }],
    sql: (node, upstream) => {
      const columns = (node.params.columns || []).filter(Boolean);
      if (columns.length < 2) throw new Error("Choose at least two numeric attributes.");
      const pairs = [];
      for (let i = 0; i < columns.length; i++) {
        for (let j = i + 1; j < columns.length; j++) {
          // One row per unordered pair: correlation is symmetric, and a full
          // matrix would say everything twice plus a diagonal of 1s.
          pairs.push(
            `SELECT ${qlit(columns[i])} AS attribute_a, ${qlit(columns[j])} AS attribute_b, ` +
              `corr(${qid(columns[i])}, ${qid(columns[j])}) AS r, ` +
              `count(*) AS n FROM ${upstream.input}`,
          );
        }
      }
      return { output: `SELECT * FROM (${pairs.join(" UNION ALL ")}) ORDER BY abs(r) DESC NULLS LAST` };
    },
  },

  /*
   * Whitebox's Attribute Histogram: "Creates a histogram for the field values of
   * a vector's attribute table."
   *
   * Again as rows rather than a picture: one row per bin, with its bounds and
   * count, which the attribute panel shows and a Writer can export.
   */
  AttributeHistogram: {
    label: "AttributeHistogram",
    group: "Analysis",
    hint: "Bins an attribute's values and counts each bin.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [
      { id: "column", label: "Attribute", kind: "column" },
      { id: "bins", label: "Bins", kind: "string", default: "20" },
    ],
    sql: (node, upstream) => {
      if (!node.params.column) throw new Error("Choose an attribute to bin.");
      const column = qid(node.params.column);
      const bins = Math.max(1, Math.round(Number(node.params.bins ?? 20)));
      if (!Number.isFinite(bins)) throw new Error("Bins must be a number.");
      // The bounds come from a window over the same scan rather than a
      // sub-select, so the data is read once.
      return {
        output:
          `WITH b AS (SELECT ${column} AS v, min(${column}) OVER () AS lo, max(${column}) OVER () AS hi ` +
          `FROM ${upstream.input} WHERE ${column} IS NOT NULL), ` +
          `w AS (SELECT *, (hi - lo) / ${bins} AS width FROM b) ` +
          `SELECT bin, ` +
          `min(lo + bin * width) AS bin_start, min(lo + (bin + 1) * width) AS bin_end, ` +
          `count(*) AS n FROM (` +
          // The maximum value would land in bin `bins`, one past the last, so it
          // is pulled back into the top bin rather than getting one of its own.
          `SELECT *, least(${bins - 1}, floor(CASE WHEN width = 0 THEN 0 ELSE (v - lo) / width END))::INT AS bin FROM w` +
          `) GROUP BY bin ORDER BY bin`,
      };
    },
  },

  /*
   * Whitebox's Vector - Geometry Processing toolbox, for the tools that are one
   * call on an existing primitive. Descriptions are Whitebox's own, taken from
   * the tool sources rather than paraphrased.
   */

  // "Identifies the centroid point of a vector polyline or polygon feature or a
  // group of vector points."
  CentroidVector: geometryTool({
    label: "CentroidVector",
    hint: "Replaces each feature with its centroid. May fall outside a concave shape.",
    build: (source) => `ST_Centroid(${source})`,
  }),

  // The centroid's honest sibling: a point guaranteed to be *on* the feature.
  RepresentativePointVector: geometryTool({
    label: "RepresentativePointVector",
    hint: "A point guaranteed to lie inside each feature — unlike a centroid.",
    build: (source) => `ST_PointOnSurface(${source})`,
  }),

  // "Creates a vector convex polygon around vector features."
  MinimumConvexHull: geometryTool({
    label: "MinimumConvexHull",
    hint: "The convex hull of each feature, or one hull around the whole layer.",
    params: [
      {
        id: "scope",
        label: "Hull around",
        kind: "select",
        options: ["Each feature", "The whole layer"],
        default: "Each feature",
      },
    ],
    build: (source, params) =>
      (params.scope ?? "Each feature") === "The whole layer"
        ? `ST_ConvexHull(ST_Union_Agg(${source}))`
        : `ST_ConvexHull(${source})`,
    collapses: (params) => (params.scope ?? "Each feature") === "The whole layer",
  }),

  SimplifyFeatures: geometryTool({
    label: "SimplifyFeatures",
    hint: "Removes vertices within a tolerance, keeping each shape valid.",
    params: [{ id: "tolerance", label: "Tolerance (degrees)", kind: "string", default: "0.001" }],
    build: (source, params) => {
      const tolerance = Number(params.tolerance ?? 0.001);
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Tolerance must be a positive number.");
      // PreserveTopology, because plain ST_Simplify will happily turn a polygon
      // into a self-intersecting one and every downstream area is then wrong.
      return `ST_SimplifyPreserveTopology(${source}, ${tolerance})`;
    },
  }),

  // "Merges vector line segments into larger features."
  MergeLineSegments: geometryTool({
    label: "MergeLineSegments",
    hint: "Joins line segments that share endpoints into longer lines.",
    build: (source) => `ST_LineMerge(${source})`,
  }),

  /*
   * "Removes any coincident, or nearly coincident, points from a vector points
   * file."
   *
   * "Nearly" is the tolerance: coordinates are snapped to a grid of that size
   * and the first point in each cell wins. Rounding rather than a pairwise
   * distance test keeps it a GROUP BY instead of a cross join.
   */
  EliminateCoincidentPoints: {
    label: "EliminateCoincidentPoints",
    group: "Geometry",
    hint: "Drops points that share a location, within a tolerance.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    needsSchema: true,
    params: [{ id: "tolerance", label: "Tolerance (degrees)", kind: "string", default: "0.00001" }],
    sql: (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error("EliminateCoincidentPoints needs a geometry column.");
      const tolerance = Number(node.params.tolerance ?? 0.00001);
      if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("Tolerance must be above zero.");
      const source = geometryExpression(geometry);
      const cell = `(round(ST_X(${source}) / ${tolerance}), round(ST_Y(${source}) / ${tolerance}))`;
      return {
        output:
          `SELECT * EXCLUDE (_pv_rn) FROM (` +
          `SELECT *, row_number() OVER (PARTITION BY ${cell}) AS _pv_rn FROM ${upstream.input}` +
          `) WHERE _pv_rn = 1`,
      };
    },
  },

  /*
   * The Whitebox geometry tools with no DuckDB primitive behind them.
   *
   * All four are the same shape — take the geometries out, map each through
   * JTS, put them back — so they share one factory and one helper, differing
   * only in which JTS call and which parameters.
   */
  ...jsGeometryTool({
    label: "MinimumBoundingBox",
    hint: "The smallest rectangle around each feature, at any angle — not axis-aligned.",
  }),
  ...jsGeometryTool({
    label: "MinimumBoundingCircle",
    hint: "The smallest circle enclosing each feature, as a polygon.",
  }),
  ...jsGeometryTool({
    label: "DensifyFeatures",
    hint: "Adds vertices so no segment is longer than the tolerance.",
    params: [{ id: "tolerance", label: "Max segment (degrees)", kind: "string", default: "0.01" }],
    options: (params) => {
      const tolerance = Number(params.tolerance ?? 0.01);
      if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("Tolerance must be above zero.");
      return { tolerance };
    },
  }),
  ...jsGeometryTool({
    label: "SmoothVectors",
    hint: "Rounds off corners by Chaikin subdivision. Each pass doubles the vertices.",
    params: [{ id: "iterations", label: "Passes", kind: "select", options: ["1", "2", "3", "4"], default: "2" }],
    options: (params) => ({ iterations: Math.max(1, Math.round(Number(params.iterations ?? 2))) }),
  }),

  /*
   * Moves geometry from one coordinate system to another.
   *
   * The graph's own rule is that everything below a Reader is lon/lat, and
   * this is the one node allowed to break it — so it declares what it produces
   * through `crs`, and compile() carries that down to every node beneath it.
   * The map reprojects back for drawing, the measuring nodes enter their
   * equal-area projection from wherever they actually are, and the H3 nodes
   * refuse outright rather than index a hexagon from metres.
   *
   * The destination is free text because PROJ accepts far more than EPSG here:
   * ESRI codes and raw +proj= strings both resolve. `check` runs the transform
   * once at compile time, so a typo is a red node now rather than an empty map
   * later — CREATE VIEW alone would evaluate nothing.
   */
  /*
   * Says what the coordinates are, without touching them.
   *
   * The CRS here belongs to the stream rather than to each feature, so this
   * is a relabelling of everything below it — the map then reprojects from
   * it to draw, a Reprojector reprojects from it, and the writers name
   * it. The use is a stream whose label is missing or wrong: points built by
   * a VertexCreator from Swiss coordinates in a spreadsheet, say, which are
   * EPSG:2056 however the stream was tagged. One stream carries one CRS, so
   * this is a single value rather than one per feature.
   */
  CoordinateSystemSetter: {
    label: "CoordinateSystemSetter",
    group: "Geometry",
    hint: "Assigns a coordinate system without changing any coordinates.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [
      {
        id: "crs",
        label: "Coordinate System",
        kind: "string",
        placeholder: "EPSG:2056, ESRI:54009, +proj=moll",
      },
    ],
    crs: (node, incoming) => (node.params.crs || "").trim() || incoming,
    sql: (node, upstream) => {
      if (!(node.params.crs || "").trim()) throw new Error("Set the coordinate system to assign, such as EPSG:2056.");
      return { output: `SELECT * FROM ${upstream.input}` };
    },
    // The choice is not checked against the data — but a name PROJ cannot resolve would only fail later, at the map or at
    // the next reprojection, so it is caught here.
    check: async (node) => {
      const crs = (node.params.crs || "").trim();
      if (!crs || crs === LONLAT) return;
      try {
        await query(`SELECT ${toCrs("ST_Point(0, 0)", crs, LONLAT)} AS probe`);
      } catch (err) {
        throw new Error(`PROJ does not know "${crs}" (${err.message})`);
      }
    },
  },

  Reprojector: {
    label: "Reprojector",
    group: "Geometry",
    hint: "Reprojects geometry into another coordinate system.",
    inputs: SINGLE_IN,
    needsSchema: true,
    outputs: () => SINGLE_OUT,
    params: [
      {
        id: "to",
        label: "Destination CRS",
        kind: "string",
        placeholder: "EPSG:2056, ESRI:54009, +proj=moll",
      },
    ],
    crs: (node, incoming) => destinationCrs(node) || incoming,
    sql: (node, upstream, ctx) => {
      const to = destinationCrs(node);
      if (!to) throw new Error("Set a destination coordinate system, such as EPSG:2056.");
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) {
        throw new Error("This input has no geometry to reproject.");
      }
      if (to === ctx.crs) return { output: `SELECT * FROM ${upstream.input}` };
      const column = qid(geometry.name);
      const moved = toCrs(geometryExpression(geometry), ctx.crs, to);
      return { output: `SELECT * EXCLUDE (${column}), ${moved} AS ${column} FROM ${upstream.input}` };
    },
    check: async (node, upstream, ctx) => {
      const to = destinationCrs(node);
      if (!to || to === ctx.crs) return;
      try {
        await query(`SELECT ${toCrs("ST_Point(0, 0)", ctx.crs, to)} AS probe`);
      } catch (err) {
        throw new Error(`PROJ does not know "${to}" (${err.message})`);
      }
    },
  },

  VertexCreator: {
    label: "VertexCreator",
    group: "Geometry",
    hint: "Adds, inserts or replaces one vertex, or replaces the geometry with a point.",
    help: {
      title: "VertexCreator",
      intro: [
        "Creates one vertex at the X, Y and optional Z Value — each a " +
          "constant, an attribute, a formula or SQL — and, by Mode: Add Point appends it " +
          "(nothing → point, point → line, line → a longer line); Replace with Point throws " +
          "the geometry away for a point, which is how a table of coordinates becomes a layer; " +
          "Insert Point at Index and Replace Point at Index put it at a position.",
        "Indexes count from 0 at the first vertex; -1 is the last and other negatives count " +
          "back from it; out-of-range values clamp to the ends. On a polygon they count the " +
          "exterior ring's corners, and the ring is closed again afterwards.",
        "A line whose ends meet after the edit becomes a polygon when Closed Line Handling is " +
          "Create Polygon and it has at least three corners.",
        "When the input and the new vertex disagree about Z, Measures/Z Conflict Value decides: " +
          "Compute interpolates the new vertex's Z from its neighbours (or gives every vertex " +
          "the new one's Z, if it is the only one), None drops Z, Custom Value fills the gaps. " +
          "Add Point on a 3D feature at an endpoint takes that endpoint's Z. Measures are not " +
          "supported and are dropped.",
        "Features the Mode cannot handle — a multi-part or collection, a polygon for Add Point, " +
          "a polygon with holes for the index modes, or a missing coordinate or index — go to " +
          "<Rejected> untouched, with the reason in rejection_code. Deaggregate first to " +
          "edit multi-part features.",
      ],
    },
    inputs: SINGLE_IN,
    needsSchema: true,
    outputs: () => [
      { id: "output", label: "Output" },
      { id: "rejected", label: "<Rejected>" },
    ],
    params: [
      { id: "mode", label: "Mode", kind: "select", options: VERTEX_MODES, default: "Add Point" },
      { id: "x", label: "X Value", kind: "valuespec" },
      { id: "y", label: "Y Value", kind: "valuespec" },
      { id: "z", label: "Z Value (optional)", kind: "valuespec" },
      {
        id: "index",
        label: "Index",
        kind: "valuespec",
        when: (node) => (node.params.mode || "Add Point").endsWith("at Index"),
      },
      {
        id: "crs",
        label: "Coordinate System",
        kind: "string",
        placeholder: "blank keeps the stream's; EPSG:2056…",
        when: (node) => node.params.mode === "Replace with Point",
      },
      { id: "removeAttributes", label: "Remove Attributes", kind: "select", options: ["No", "Yes"], default: "No" },
      {
        id: "zConflict",
        label: "Measures/Z Conflict Value",
        kind: "select",
        options: VERTEX_Z_CONFLICT,
        default: "Compute",
        when: (node) => node.params.mode !== "Replace with Point",
      },
      {
        id: "zCustom",
        label: "Custom Z",
        kind: "string",
        default: "0",
        when: (node) => node.params.mode !== "Replace with Point" && node.params.zConflict === "Custom Value",
      },
      {
        id: "ignoreDuplicates",
        label: "Ignore Duplicated Coordinates",
        kind: "select",
        options: ["Yes", "No"],
        default: "Yes",
        when: (node) => (node.params.mode || "Add Point") === "Add Point",
      },
      {
        id: "closedLines",
        label: "Closed Line Handling",
        kind: "select",
        options: ["Create Polygon", "Create Line"],
        default: "Create Polygon",
        when: (node) => node.params.mode !== "Replace with Point",
      },
    ],
    // A new point in a named CRS is the one case where the stream changes CRS;
    // every other mode edits coordinates that are already in the stream's.
    crs: (node, incoming) =>
      node.params.mode === "Replace with Point" && (node.params.crs || "").trim() ? node.params.crs.trim() : incoming,
    sql: (node, upstream, ctx) => vertexCreatorSql(node, upstream, ctx.schemas?.input || []),
  },

  /*
   * Polygon -> H3, the h3ronpy `geometry_to_cells` job.
   *
   * The fill happens in JS because DuckDB-WASM has no H3 extension: the rows are
   * materialised with an id, their geometry handed to h3-js as GeoJSON, and the
   * resulting (feature, cell) pairs inserted back as a table to join against.
   * The id has to come from a real table rather than a `row_number()` computed
   * on the fly — the same window over two scans is not promised to agree, and a
   * mismatch would attach cells to the wrong rows.
   */
  PolygonToH3: {
    label: "PolygonToH3",
    needsLonLat: true,
    group: "H3",
    hint: "Fills polygons with H3 cells — one row per cell, carrying the polygon's attributes.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    needsSchema: true,
    params: [
      {
        id: "resolution",
        label: "Resolution",
        kind: "select",
        options: Array.from({ length: 16 }, (_, index) => String(index)),
        default: "7",
      },
      {
        id: "mode",
        label: "Polygon fill mode",
        kind: "select",
        options: Object.keys(FILL_MODES),
        default: "ContainsCentroid",
      },
      { id: "indexColumn", label: "Index attribute", kind: "string", default: H3_INDEX_COLUMN },
      {
        id: "geometry",
        label: "Geometry",
        kind: "select",
        options: ["Hexagons", "None (index only)"],
        default: "Hexagons",
      },
    ],
    prepare: async (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      if (!geometry) throw new Error("This input has no geometry to fill.");
      const resolution = Number(node.params.resolution ?? 7);
      const source = `${cellTableName(node)}_src`;
      const cells = `${cellTableName(node)}_fill`;

      // A table, not a view: the feature ids must not be recomputed between the
      // read below and the join in sql().
      await exec(
        `CREATE OR REPLACE TABLE ${source} AS ` +
          `SELECT row_number() OVER () AS ${qid(FEATURE_ID_COLUMN)}, * FROM ${upstream.input}`,
      );
      const rows = await query(
        `SELECT ${qid(FEATURE_ID_COLUMN)} AS fid, ` +
          `ST_AsGeoJSON(${geometryExpression(geometry)}) AS geojson FROM ${source}`,
      );
      await createPolygonFillTable(rows, resolution, node.params.mode || "ContainsCentroid", cells);
      // Dropped newest first, though neither depends on the other.
      return { tables: [source, cells] };
    },
    sql: (node, upstream, ctx) => {
      const geometry = findGeometryColumn(ctx.schemas?.input || []);
      const index = qid(node.params.indexColumn || H3_INDEX_COLUMN);
      const source = `${cellTableName(node)}_src`;
      const cells = `${cellTableName(node)}_fill`;
      // The source polygon goes either way: what leaves here is one row per
      // cell, and keeping the original shape would have the map draw polygons
      // over their own hexagons.
      //
      // The cell's hexagon replaces it by default. Emitting only the index
      // makes this node a dead end for everything downstream that needs a
      // shape — a Dissolver on its output fails with "no geometry" while the
      // map, which falls back to the index column, still draws hexagons. That
      // gap is confusing enough to be worth the WKB.
      const drop = [FEATURE_ID_COLUMN, geometry?.name].filter(Boolean).map(qid).join(", ");
      const shape =
        (node.params.geometry ?? "Hexagons") === "Hexagons"
          ? `, f.geometry AS ${qid(geometry?.name || "geometry")}`
          : "";
      return {
        output:
          `SELECT s.* EXCLUDE (${drop}), f.cell AS ${index}${shape} ` +
          `FROM ${source} s JOIN ${cells} f ON s.${qid(FEATURE_ID_COLUMN)} = f.fid`,
      };
    },
  },

  H3GeometryFromIndex: {
    label: "H3GeometryFromIndex",
    crs: () => LONLAT,
    group: "H3",
    hint: "Builds hexagon geometry from an existing H3 index column.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [
      { id: "indexColumn", label: "Index attribute", kind: "column" },
      { id: "sample", label: "Sample every Nth", kind: "select", options: SAMPLE_STEPS, default: "Auto" },
      { id: "geometryColumn", label: "Geometry attribute", kind: "string", default: "geometry" },
    ],
    needsRowCount: true,
    prepare: async (node, upstream, ctx) => {
      const column = qid(node.params.indexColumn || H3_INDEX_COLUMN);
      // Sampled on a hash of the index rather than on row order, so the same
      // cells are chosen here and in the join below.
      const where = sampleWhere(sampleStep(node, ctx), `hash(${column})`);
      const notNull = where ? `${where} AND ${column} IS NOT NULL` : ` WHERE ${column} IS NOT NULL`;
      return buildCellTable(node, `SELECT DISTINCT ${column} AS cell FROM ${upstream.input}${notNull}`);
    },
    sql: (node, upstream, ctx) => {
      const column = qid(node.params.indexColumn || H3_INDEX_COLUMN);
      const geometry = qid(node.params.geometryColumn || "geometry");
      const where = sampleWhere(sampleStep(node, ctx), `hash(v.${column})`);
      return {
        output:
          `SELECT v.*, g.geometry AS ${geometry} FROM ${upstream.input} v ` +
          `JOIN ${cellTableName(node)} g ON v.${column} = g.cell${where}`,
      };
    },
  },

  H3GeometryFromPosition: {
    label: "H3GeometryFromPosition",
    crs: () => LONLAT,
    group: "H3",
    hint: "Row order straight to hexagons — the two H3 nodes in one.",
    inputs: SINGLE_IN,
    outputs: () => SINGLE_OUT,
    params: [
      { id: "parent", label: "Parent cell", kind: "string", placeholder: "from the file name" },
      { id: "resolution", label: "Child resolution", kind: "string", placeholder: "from the row count" },
      { id: "sample", label: "Sample every Nth", kind: "select", options: SAMPLE_STEPS, default: "Auto" },
      { id: "geometryColumn", label: "Geometry attribute", kind: "string", default: "geometry" },
    ],
    needsSchema: true,
    needsRowCount: true,
    prepare: async (node, upstream, ctx) => {
      const expr = positionalExprFor(node, ctx);
      const where = sampleWhere(sampleStep(node, ctx), qid(ROW_NUMBER_COLUMN));
      return buildCellTable(node, `SELECT DISTINCT ${expr} AS cell FROM ${upstream.input}${where}`);
    },
    sql: (node, upstream, ctx) => {
      // Qualified with the alias, since the row number is now one side of a join.
      const expr = positionalExprFor(node, ctx, "v");
      const geometry = qid(node.params.geometryColumn || "geometry");
      const where = sampleWhere(sampleStep(node, ctx), `v.${qid(ROW_NUMBER_COLUMN)}`);
      return {
        output:
          `SELECT v.* EXCLUDE (${qid(ROW_NUMBER_COLUMN)}), ${expr} AS ${qid(H3_INDEX_COLUMN)}, ` +
          `g.geometry AS ${geometry} FROM ${upstream.input} v ` +
          `JOIN ${cellTableName(node)} g ON ${expr} = g.cell${where}`,
      };
    },
  },
};

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
import { findGeometryColumn, geometryExpression, LONLAT } from "../app/src/core/schema.js";
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

/* Reading a plan's chunks and flattening the cells into a DuckDB table. */

import { db, exec, qid, qlit } from "../../core/duck.js";
import { describe, findGeometryColumn } from "../../core/schema.js";
import * as zarrita from "zarrita";
import { medianStep, planStats } from "./plan.js";

/** Rows per INSERT. Matches the H3 builder: enough to be fast, small enough to yield. */
const INSERT_BATCH = 50_000;

/** Zarr dtype -> the DuckDB column type that loses nothing. */
export const DUCKDB_TYPES = {
  int8: "TINYINT",
  int16: "SMALLINT",
  int32: "INTEGER",
  int64: "BIGINT",
  uint8: "UTINYINT",
  uint16: "USMALLINT",
  uint32: "UINTEGER",
  uint64: "UBIGINT",
  float16: "FLOAT",
  float32: "FLOAT",
  float64: "DOUBLE",
  bool: "BOOLEAN",
};

let reportProgress = null;

/** Where long reads announce themselves; the app points this at the status line. */
export function setProgressReporter(fn) {
  reportProgress = fn;
}

/* ---------- reading ---------- */

/** Pull one value out of a decoded chunk, whatever its typed array is. */
function valueReaderFor(dtype) {
  if (dtype === "bool") return (data, index) => Boolean(data.get ? data.get(index) : data[index]);
  if (dtype === "int64" || dtype === "uint64") return (data, index) => Number(data[index]);
  return (data, index) => data[index];
}

/** A name usable as a column: nested array paths carry slashes, dims can be blank. */
function safeName(name, fallback) {
  const cleaned = String(name).split("/").filter(Boolean).pop() || fallback;
  // A leading digit is left alone — ERA5's `2m_temperature` is a real variable
  // name, every reference to a column here goes through `qid`, and renaming it
  // to `_2m_temperature` would only hide where the numbers came from.
  return cleaned.replace(/[^\w]/g, "_") || fallback;
}

/** Column names, uniquified so a dimension called "x" cannot shadow the coordinate. */
function columnNames(variable, georeference) {
  const taken = new Set(["x", "y", "x_index", "y_index", "geom"]);
  const unique = (name) => {
    let candidate = name;
    let suffix = 2;
    while (taken.has(candidate)) candidate = `${name}_${suffix++}`;
    taken.add(candidate);
    return candidate;
  };
  const pins = {};
  for (const [axis, dim] of variable.dims.entries()) {
    if (axis !== variable.yAxis && axis !== variable.xAxis) pins[dim] = unique(safeName(dim, `dim_${axis}`));
  }
  return { value: unique(safeName(variable.name, "value")), pins, indexed: georeference.kind !== "none" };
}

/** The selection handed to zarrita for one slab of rows. */
function selectionFor(variable, plan, yStart, yStop) {
  return variable.dims.map((dim, axis) => {
    if (axis === variable.yAxis) return zarrita.slice(yStart, yStop, plan.step);
    if (axis === variable.xAxis) return zarrita.slice(plan.window.x[0], plan.window.x[1], plan.step);
    return plan.pins[dim] ?? 0;
  });
}

/** Cell-centre coordinates of one array position. */
function centreFor(georeference, row, col) {
  if (georeference.kind === "affine") {
    const { a, b, c, d, e, f } = georeference.affine;
    return [a * (col + 0.5) + b * (row + 0.5) + c, d * (col + 0.5) + e * (row + 0.5) + f];
  }
  if (georeference.kind === "coords") {
    return [georeference.xValues[col], georeference.yValues[row]];
  }
  return [col, row];
}

/**
 * The signed size of one cell along each axis — signed because a raster's rows
 * usually run north to south, and the sign is what says which way.
 */
function cellSizeFor(georeference) {
  if (georeference.kind === "affine") return [georeference.affine.a, georeference.affine.e];
  const xValues = georeference.xValues;
  const yValues = georeference.yValues;
  return [
    Math.sign(xValues.at(-1) - xValues[0] || 1) * medianStep(xValues),
    Math.sign(yValues.at(-1) - yValues[0] || 1) * medianStep(yValues),
  ];
}

/**
 * The geometry expression, built in the store's own CRS for the Reader to
 * reproject.
 *
 * A footprint runs from the sampled cell's own edge across the whole block it
 * stands for, rather than sitting centred on the cell: with a stride of 2 a
 * centred box would be half a cell out of place, and at the top of a global
 * grid it would reach past the pole. Hence the corner, `x - a/2`, and a signed
 * span from there — `least`/`greatest` then put the envelope's corners the
 * right way round whichever direction the axis runs.
 */
function geometryExpressionFor(plan, georeference) {
  if (georeference.kind === "none") return null;
  if (plan.geometry !== "footprint" || georeference.rotated) return "ST_Point(x, y)";
  const [cellX, cellY] = cellSizeFor(georeference);
  const x0 = `(x - ${cellX / 2})`;
  const y0 = `(y - ${cellY / 2})`;
  const x1 = `(x - ${cellX / 2} + ${cellX * plan.step})`;
  const y1 = `(y - ${cellY / 2} + ${cellY * plan.step})`;
  return (
    `ST_MakeEnvelope(least(${x0}, ${x1}), least(${y0}, ${y1}), ` + `greatest(${x0}, ${x1}), greatest(${y0}, ${y1}))`
  );
}

function createTableSql(tableName, variable, names, plan, georeference) {
  const columns = ["y_index BIGINT", "x_index BIGINT"];
  // No geo-reference means no coordinates to carry and no geometry to build —
  // the array indexes are all there is, and saying so beats inventing a grid.
  if (names.indexed) columns.push("x DOUBLE", "y DOUBLE");
  for (const column of Object.values(names.pins)) columns.push(`${qid(column)} DOUBLE`);
  const scaled = variable.scaleFactor !== 1 || variable.addOffset !== 0;
  columns.push(`${qid(names.value)} ${scaled ? "DOUBLE" : DUCKDB_TYPES[variable.dtype]}`);
  if (geometryExpressionFor(plan, georeference)) columns.push("geom GEOMETRY");
  return `CREATE OR REPLACE TABLE ${tableName} (${columns.join(", ")})`;
}

/** Chunk-aligned row slabs covering the window, so one read is one band of chunks. */
function slabsFor(variable, plan) {
  const [y0, y1] = plan.window.y;
  const chunkHeight = variable.chunks[variable.yAxis];
  const slabs = [];
  for (let start = Math.floor(y0 / chunkHeight) * chunkHeight; start < y1; start += chunkHeight) {
    // The sampled positions are fixed relative to the window's start, so a slab
    // has to begin at the first sampled row inside it rather than at its own
    // edge — otherwise every slab restarts the stride and the grid goes wonky.
    const offset = Math.max(0, Math.ceil((Math.max(start, y0) - y0) / plan.step)) * plan.step + y0;
    if (offset >= Math.min(start + chunkHeight, y1)) continue;
    slabs.push([offset, Math.min(start + chunkHeight, y1)]);
  }
  return slabs;
}

/**
 * Build the table for one variable under one plan.
 *
 * Rows travel to DuckDB as newline JSON in a registered buffer, the same way
 * the H3 hexagon builder does it, which keeps this dependency-free; the
 * geometry is built in the INSERT so it never crosses as text.
 */
export async function materialize(store, variable, plan, georeference, tableName) {
  const names = columnNames(variable, georeference);
  const readValue = valueReaderFor(variable.dtype);
  const geometry = geometryExpressionFor(plan, georeference);
  const scaled = variable.scaleFactor !== 1 || variable.addOffset !== 0;
  const pinValues = {};
  for (const [dim, column] of Object.entries(names.pins)) {
    const index = plan.pins[dim] ?? 0;
    pinValues[column] = georeference.labels[dim]?.[index] ?? index;
  }

  await exec(createTableSql(tableName, variable, names, plan, georeference));

  const encoder = new TextEncoder();
  const yFirst = variable.yAxis < variable.xAxis;
  const slabs = slabsFor(variable, plan);
  const expected = planStats(variable, plan).rows;
  let pending = [];
  let written = 0;
  let batchIndex = 0;

  const flush = async () => {
    if (!pending.length) return;
    const jsonName = `${tableName}_${batchIndex++}.json`;
    await db().registerFileBuffer(jsonName, encoder.encode(pending.join("\n")));
    pending = [];
    try {
      const selection = [
        ...(names.indexed ? ["y_index", "x_index", "x", "y"] : ["y_index", "x_index"]),
        ...Object.values(names.pins).map(qid),
        qid(names.value),
        ...(geometry ? [geometry] : []),
      ].join(", ");
      await exec(`INSERT INTO ${tableName} SELECT ${selection} FROM read_json_auto(${qlit(jsonName)})`);
    } finally {
      await db().dropFile(jsonName);
    }
  };

  for (const [slabIndex, [slabStart, slabStop]] of slabs.entries()) {
    reportProgress?.(
      `Reading ${variable.name}… band ${slabIndex + 1} of ${slabs.length}, ${written.toLocaleString()} of ~${expected.toLocaleString()} cells`,
    );
    const chunk = await zarrita.get(variable.array, selectionFor(variable, plan, slabStart, slabStop));
    // The result keeps the array's own axis order, minus the pinned dimensions
    // — so an array stored `(x, y)` hands back `(x, y)`, and reading it as
    // rows-then-columns would transpose the raster. Which output axis is which
    // follows from the order the two spatial axes appear in.
    const [heightOut, widthOut] = yFirst ? chunk.shape : [chunk.shape[1], chunk.shape[0]];
    const [strideY, strideX] = yFirst ? chunk.stride : [chunk.stride[1], chunk.stride[0]];

    for (let i = 0; i < heightOut; i++) {
      const row = slabStart + i * plan.step;
      for (let j = 0; j < widthOut; j++) {
        const raw = readValue(chunk.data, i * strideY + j * strideX);
        const isNodata =
          raw == null ||
          (typeof raw === "number" &&
            (Number.isNaN(raw) || (variable.nodata !== undefined && raw === variable.nodata)));
        if (isNodata && plan.skipNodata) continue;
        const col = plan.window.x[0] + j * plan.step;
        const record = { y_index: row, x_index: col };
        if (names.indexed) {
          const [x, y] = centreFor(georeference, row, col);
          record.x = x;
          record.y = y;
        }
        Object.assign(record, pinValues);
        record[names.value] = isNodata ? null : scaled ? raw * variable.scaleFactor + variable.addOffset : raw;
        pending.push(JSON.stringify(record));
        written += 1;
        if (pending.length >= INSERT_BATCH) await flush();
      }
    }
  }
  await flush();
  reportProgress?.(null);

  const columns = await describe(tableName);
  return {
    table: tableName,
    columns,
    rows: written,
    geometry: findGeometryColumn(columns),
    valueColumn: names.value,
  };
}

/** Drop a materialised Zarr table. Called when its layer is removed. */
export async function dropTable(tableName) {
  try {
    await exec(`DROP TABLE IF EXISTS ${tableName}`);
  } catch (err) {
    console.warn(`Could not drop ${tableName}`, err);
  }
}

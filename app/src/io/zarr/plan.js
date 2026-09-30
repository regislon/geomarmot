/*
 * The geo-reference of a variable, and read plans: window, stride, and what a
 * read will cost before it is attempted.
 */

import { affineFromAttributes, coordinateValues, crsFromAttributes } from "./metadata.js";

/** How many cells a read produces by default; the map draws 8k-250k happily. */
export const DEFAULT_CELL_BUDGET = 200_000;

/**
 * Beyond these a read is refused rather than attempted.
 *
 * Bytes is the cap that matters, and it is not the same thing as chunks: a
 * chunk of such a population grid is `(20, 512, 512)` — the whole time axis in one
 * chunk — so pinning a year makes the row count twenty times smaller and the
 * download exactly as large. A thousand of those chunks is 5 GB. The chunk
 * count is capped as well because each one is an HTTP request.
 */
const MAX_ROWS = 5_000_000;
const MAX_CHUNKS = 4_000;
const MAX_READ_BYTES = 2 * 1024 ** 3;

/** What the opening window is sized to, before anyone has asked for more. */
const DEFAULT_READ_BYTES = 256 * 1024 ** 2;

/**
 * The geo-reference for one variable, and the coordinate labels for its other
 * dimensions. Needs reads, so it is done when a variable is chosen rather than
 * for every array in the store.
 */
export async function resolveGeoreference(store, variable) {
  const gridMapping = variable.attrs.grid_mapping
    ? store.coordinates.get(String(variable.attrs.grid_mapping))?.attrs
    : null;
  const spatialRef = store.coordinates.get("spatial_ref")?.attrs || null;
  const crs = crsFromAttributes(variable.attrs, gridMapping, spatialRef, variable.groupAttrs);
  const affine = affineFromAttributes(variable.attrs, spatialRef, gridMapping, variable.groupAttrs);

  const labels = {};
  for (const [axis, dim] of variable.dims.entries()) {
    if (axis === variable.yAxis || axis === variable.xAxis) continue;
    const values = await coordinateValues(store.coordinates.get(dim));
    if (values) labels[dim] = values;
  }

  if (affine) {
    return { kind: "affine", crs, affine, labels, rotated: affine.b !== 0 || affine.d !== 0 };
  }

  const yValues = await coordinateValues(store.coordinates.get(variable.dims[variable.yAxis]));
  const xValues = await coordinateValues(store.coordinates.get(variable.dims[variable.xAxis]));
  if (yValues && xValues) {
    return { kind: "coords", crs, yValues, xValues, labels, rotated: false };
  }
  return { kind: "none", crs: null, labels, rotated: false };
}

/** Median absolute step of a coordinate array — the cell size it implies. */
export function medianStep(values) {
  if (!values || values.length < 2) return 1;
  const steps = [];
  for (let i = 1; i < values.length; i++) steps.push(Math.abs(values[i] - values[i - 1]));
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] || 1;
}

/* ---------- planning a read ---------- */

/** The stride that brings a window's cell count under a budget. */
function stepFor(height, width, budget) {
  if (!budget || height * width <= budget) return 1;
  return Math.max(1, Math.ceil(Math.sqrt((height * width) / budget)));
}

/** Bytes one cell of this dtype occupies, decoded. */
function bytesPerCell(dtype) {
  return Number(/\d+/.exec(dtype)?.[0] || 8) / 8;
}

/** Bytes one whole chunk occupies, decoded — the real unit of a read's cost. */
function chunkBytes(variable) {
  return variable.chunks.reduce((total, length) => total * length, 1) * bytesPerCell(variable.dtype);
}

/**
 * How many chunks along each spatial axis a byte budget affords.
 *
 * Square, because the spatial axes are interchangeable here and a window that
 * is 4000 chunks wide and one tall is nobody's idea of a sample.
 */
function affordableChunksPerAxis(variable, byteBudget) {
  const affordable = Math.floor(byteBudget / chunkBytes(variable));
  return Math.max(1, Math.floor(Math.sqrt(Math.min(affordable, MAX_CHUNKS))));
}

/**
 * A window over one axis, centred and chunk-aligned, of at most `chunkBudget`
 * chunks. Aligned because the chunk is what gets fetched: a window that starts
 * mid-chunk pays for the whole chunk anyway.
 */
function centredWindow(length, chunkLength, chunkBudget) {
  const span = Math.min(length, chunkBudget * chunkLength);
  if (span >= length) return [0, length];
  const start = Math.floor((length - span) / 2 / chunkLength) * chunkLength;
  return [start, Math.min(length, start + span)];
}

/**
 * A read plan: the window, the stride, and what to do with each cell.
 *
 * The whole spatial extent is the obvious default and is what you get whenever
 * the array is small enough for it. It is not always: a global population grid is
 * 1.44M x 528k cells in 512-square chunks, and its whole extent is 2.9 million
 * chunks and 15 TB — a default that opens refused and says "narrow it" leaves
 * you guessing at numbers. So a store that big opens on a patch in the middle
 * of it instead, sized to the chunk budget, which is something you can look at
 * and then move. `narrowed` says that happened, so the picker can too.
 */
export function defaultPlan(variable, budget = DEFAULT_CELL_BUDGET) {
  const height = variable.shape[variable.yAxis];
  const width = variable.shape[variable.xAxis];
  const pins = {};
  for (const [axis, dim] of variable.dims.entries()) {
    if (axis !== variable.yAxis && axis !== variable.xAxis) pins[dim] = 0;
  }
  const perAxis = affordableChunksPerAxis(variable, DEFAULT_READ_BYTES);
  const y = centredWindow(height, variable.chunks[variable.yAxis], perAxis);
  const x = centredWindow(width, variable.chunks[variable.xAxis], perAxis);
  return {
    pins,
    window: { y, x },
    budget,
    step: stepFor(y[1] - y[0], x[1] - x[0], budget),
    geometry: "point",
    skipNodata: true,
    narrowed: y[1] - y[0] < height || x[1] - x[0] < width,
  };
}

/** Output size and read cost of a plan, before anything is fetched. */
export function planStats(variable, plan) {
  const [y0, y1] = plan.window.y;
  const [x0, x1] = plan.window.x;
  const rowsOut = Math.max(0, Math.ceil((y1 - y0) / plan.step));
  const colsOut = Math.max(0, Math.ceil((x1 - x0) / plan.step));

  let chunks = 1;
  for (const [axis] of variable.dims.entries()) {
    const chunkLength = variable.chunks[axis];
    if (axis === variable.yAxis) {
      chunks *= Math.ceil(y1 / chunkLength) - Math.floor(y0 / chunkLength);
    } else if (axis === variable.xAxis) {
      chunks *= Math.ceil(x1 / chunkLength) - Math.floor(x0 / chunkLength);
    }
    // A pinned dimension costs one chunk along that axis, whatever its length.
  }

  return {
    rows: rowsOut * colsOut,
    rowsOut,
    colsOut,
    chunks,
    // Uncompressed: the compressed size is not knowable without asking for the
    // chunks, and understating the cost is the worse error of the two.
    bytes: chunks * chunkBytes(variable),
  };
}

/** The reason a plan cannot be run, or null. */
export function planRefusal(variable, plan) {
  const stats = planStats(variable, plan);
  if (!stats.rows) return "That window is empty.";
  if (stats.rows > MAX_ROWS) {
    return `${stats.rows.toLocaleString()} rows is more than the ${MAX_ROWS.toLocaleString()} this can build — raise the sampling or narrow the window.`;
  }
  if (stats.bytes > MAX_READ_BYTES) {
    return (
      `That window is ${(stats.bytes / 1024 ** 3).toFixed(1)} GB to read ` +
      `(limit ${MAX_READ_BYTES / 1024 ** 3} GB). Narrow it — a coarser sampling reads the same bytes.`
    );
  }
  if (stats.chunks > MAX_CHUNKS) {
    return `That window touches ${stats.chunks.toLocaleString()} chunks, one request each (limit ${MAX_CHUNKS.toLocaleString()}). Narrow it.`;
  }
  return null;
}

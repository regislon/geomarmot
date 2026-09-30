/*
 * Zarr stores, read as tables of cells.
 *
 * A Zarr store is not a file. It is a folder of compressed chunks plus a little
 * JSON describing how they fit together, so nothing in the rest of this app
 * applies to it: there is no footer to read, no single object to register with
 * DuckDB, and nothing to drop onto the page. What there is instead is an
 * n-dimensional array — `(year, y, x)` in a typical raster store — and a
 * grid geo-reference hidden in its attributes.
 *
 * So the reader's job is a translation: pick one array, pin every dimension
 * that is not spatial, sample the spatial ones, and hand DuckDB one row per
 * cell with real coordinates on it. From there a Zarr layer is an ordinary
 * table with a geometry column and behaves like every other source.
 *
 * Two things about the I/O are worth knowing before reading further, because
 * the whole plan/estimate machinery below exists because of them.
 *
 *   1. The chunk is the unit of transfer. Sampling every 100th cell of a window
 *      still downloads every chunk that window touches — a stride buys rows,
 *      never bytes. Narrowing the window is the only thing that buys bytes.
 *   2. The arrays are big. A global population grid is 1.44M x 528k cells; one cell per
 *      row would be 760 billion rows. Nothing here is allowed to start a read
 *      without first saying how much it will cost.
 *
 * zarrita does the format work — v2 and v3, consolidated metadata, sharding —
 * and reaches numcodecs for blosc/zstd chunks. Both are loaded lazily, so a
 * session that never opens a Zarr never pays for them.
 */

import * as zarrita from "zarrita";

import { db, exec, qid, qlit } from "../core/duck.js";
import { describe, findGeometryColumn } from "../core/schema.js";

/** A store is a folder whose name ends in .zarr — there is no file to test. */
const STORE_SUFFIX = /\.zarr\/?$/i;

/** Dimension names that conventionally mean "down the rows" and "across". */
const Y_DIMENSION_NAMES = new Set(["y", "lat", "latitude", "northing", "row"]);
const X_DIMENSION_NAMES = new Set(["x", "lon", "long", "longitude", "easting", "col", "column"]);

/** Attributes that carry a CRS, in the order they are worth believing. */
const CRS_ATTRIBUTES = ["crs_wkt", "spatial_ref", "crs", "proj:wkt2", "esri_pe_string", "epsg"];

/** Attributes that mean "this value is not a measurement". */
const NODATA_ATTRIBUTES = ["_FillValue", "missing_value", "nodata", "nodatavals", "fill_value"];

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

/** Rows per INSERT. Matches the H3 builder: enough to be fast, small enough to yield. */
const INSERT_BATCH = 50_000;

/** Zarr dtype -> the DuckDB column type that loses nothing. */
const DUCKDB_TYPES = {
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

/** True when a path names a Zarr store rather than a file. */
export function isZarrStore(path) {
  return STORE_SUFFIX.test(String(path).split("?")[0]);
}

/**
 * True when a path points somewhere inside a store — `…/gpw.zarr/band`.
 *
 * Worth telling apart from the store itself, because a store can be browsed for
 * its arrays and a path into one already names the array to read.
 */
export function isZarrPath(path) {
  return /\.zarr(\/|$)/i.test(String(path).split("?")[0]);
}

/* ---------- metadata ---------- */

/** The bit of a WKT that names its EPSG code, or null. */
function epsgFromWkt(text) {
  const matches = [...String(text).matchAll(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  const last = matches.at(-1);
  return last ? `EPSG:${last[1]}` : null;
}

/**
 * A CRS as {code, wkt, assumed}, from whichever attribute carries one.
 *
 * The WKT is kept alongside the code because it is what actually gets handed to
 * PROJ when no EPSG code can be picked out of it — ST_Transform takes either,
 * and a store with a bare WKT is better reprojected from that WKT than declared
 * "unknown" and left where it is.
 */
function crsFromAttributes(...attributeSets) {
  for (const attrs of attributeSets) {
    if (!attrs) continue;
    for (const key of CRS_ATTRIBUTES) {
      const value = attrs[key];
      if (value == null) continue;
      if (typeof value === "number")
        return { code: `EPSG:${value}`, display: `EPSG:${value}`, wkt: null, assumed: false };
      const text = String(value).trim();
      if (!text) continue;
      if (/^(EPSG|ESRI|OGC):/i.test(text)) {
        return { code: text.toUpperCase(), display: text.toUpperCase(), wkt: null, assumed: false };
      }
      if (/^\d+$/.test(text)) return { code: `EPSG:${text}`, display: `EPSG:${text}`, wkt: null, assumed: false };
      const code = epsgFromWkt(text);
      // A WKT with no EPSG code in it is still perfectly good to reproject
      // from — PROJ takes the WKT itself — but it is far too long to show, so
      // the CRS's own name comes along for the badge.
      const named = /^\s*(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS|BOUNDCRS)\s*\[\s*"([^"]+)"/.exec(text);
      return { code: code || text, display: code || named?.[1] || "from WKT", wkt: text, assumed: false };
    }
  }
  return null;
}

/** The first nodata value any of these attribute sets declares, or undefined. */
function nodataFromAttributes(...attributeSets) {
  for (const attrs of attributeSets) {
    if (!attrs) continue;
    for (const key of NODATA_ATTRIBUTES) {
      let value = attrs[key];
      if (Array.isArray(value)) value = value[0];
      if (value == null) continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return undefined;
}

/**
 * The grid geo-reference, read from attributes rather than guessed.
 *
 * Three conventions turn up, and they disagree about the order of the same six
 * numbers, so each is read on its own terms:
 *
 *   `transform`    — rasterio's Affine, (xres, xskew, xmin, yskew, yres, ymax).
 *                    This is what rasterio-based writers produce.
 *   `GeoTransform` — GDAL's order, (xmin, xres, xskew, ymax, yskew, yres),
 *                    usually on a `spatial_ref` array put there by rioxarray.
 *   coordinate arrays — a 1-D array per spatial dimension holding cell centres,
 *                    which is what xarray writes and what CF expects.
 *
 * Mixing the first two up rotates the raster into the sea rather than failing,
 * so the attribute name decides and nothing is inferred from the values.
 */
function affineFromAttributes(...attributeSets) {
  for (const attrs of attributeSets) {
    if (!attrs) continue;
    const rasterio = attrs.transform;
    if (Array.isArray(rasterio) && rasterio.length >= 6) {
      const [a, b, c, d, e, f] = rasterio.map(Number);
      return { a, b, c, d, e, f, source: "transform" };
    }
    const gdal = attrs.GeoTransform ?? attrs.geotransform;
    if (gdal != null) {
      const parts = (
        Array.isArray(gdal)
          ? gdal
          : String(gdal)
              .trim()
              .split(/[\s,]+/)
      ).map(Number);
      if (parts.length >= 6 && parts.every(Number.isFinite)) {
        const [c, a, b, f, d, e] = parts;
        return { a, b, c, d, e, f, source: "GeoTransform" };
      }
    }
  }
  return null;
}

/* ---------- opening a store ---------- */

/** Bucket and key of a /proxy/gs URL, so the store's folder can be listed. */
function gcsTargetOf(url) {
  const match = /\/proxy\/gs\/([^/]+)\/(.*)$/.exec(new URL(url, window.location.href).pathname);
  if (!match) return null;
  return { bucket: decodeURIComponent(match[1]), prefix: decodeURIComponent(match[2]).replace(/\/?$/, "/") };
}

/**
 * The names of the store's immediate children, or null when they cannot be had.
 *
 * Consolidated metadata answers this for free and is the only way that works on
 * an arbitrary host: HTTP has no directory listing, and a store written without
 * `.zmetadata` (which is every store `zarr.open_group` makes) gives a browser
 * nothing to enumerate. For the buckets this app is pointed at there is a way
 * round it — the local server's /list endpoint — and for anything else the array
 * has to be named in the path.
 */
async function childNames(store, url) {
  if (typeof store.contents === "function") {
    return store
      .contents()
      .filter((entry) => entry.kind === "array" && entry.path !== "/")
      .map((entry) => entry.path.replace(/^\//, ""));
  }
  const target = gcsTargetOf(url);
  if (!target) return null;
  const listing = new URL("list", window.location.href);
  listing.searchParams.set("bucket", target.bucket);
  listing.searchParams.set("prefix", target.prefix);
  const response = await fetch(listing);
  if (!response.ok) return null;
  const page = await response.json();
  return (page.prefixes || []).map((folder) => folder.slice(target.prefix.length).replace(/\/$/, ""));
}

/** Open one array, or null when that name is a group or is not there. */
async function openArray(store, path) {
  try {
    return await zarrita.open(zarrita.root(store).resolve(path), { kind: "array" });
  } catch {
    return null;
  }
}

/** Open the store's own root as an array — for a path that named one. */
async function openSelfArray(store) {
  try {
    return await zarrita.open(store, { kind: "array" });
  } catch {
    return null;
  }
}

/**
 * 3 or 2, by which metadata document the store actually has.
 *
 * Only for the label in the picker: zarrita reads either format through the
 * same API, so nothing downstream branches on this.
 */
async function storeFormat(store) {
  try {
    return (await store.get("/zarr.json")) ? 3 : 2;
  } catch {
    return 2;
  }
}

/**
 * Everything about a store the picker needs: its arrays, and the group attrs.
 *
 * Arrays of one dimension are coordinates rather than layers — `year`, `x`,
 * `y` — so they are kept aside to label the dimensions of the real ones rather
 * than offered as something to read.
 */
export async function openZarrStore(url, displayName) {
  const raw = new zarrita.FetchStore(url.replace(/\/$/, ""));
  const store = await zarrita.withMaybeConsolidatedMetadata(raw);

  let group = null;
  try {
    group = await zarrita.open(store, { kind: "group" });
  } catch {
    // A path pointing straight at an array has no group metadata of its own.
  }

  const arrays = [];
  const coordinates = new Map();
  for (const name of (group ? await childNames(store, url) : null) || []) {
    const array = await openArray(store, name);
    if (!array) continue;
    // One dimension means a coordinate — `year`, `x`, `y`, `spatial_ref` — which
    // is how the others get their labels and their geo-reference.
    if (array.shape.length === 1) coordinates.set(name, array);
    else arrays.push({ name, array });
  }

  // Either the path named the array itself, or the store could not be listed.
  if (!arrays.length) {
    const self = await openSelfArray(store);
    if (self) {
      const name = decodeURIComponent(url.replace(/\/$/, "").split("/").pop() || "array");
      arrays.push({ name, array: self });
      // Its coordinates and its geo-reference live one level up, in the parent.
      const parent = await openParentGroup(url.replace(/\/$/, "").replace(/\/[^/]+$/, ""), coordinates);
      if (parent) group = parent;
    }
  }

  if (!arrays.length) {
    throw new Error(
      group
        ? "No arrays found in this store. Point the path at one of its arrays — " +
            `${displayName}/<array> — or consolidate the store's metadata.`
        : "That path is neither a Zarr group nor a Zarr array.",
    );
  }

  return {
    url,
    name: displayName,
    zarrFormat: await storeFormat(store),
    groupAttrs: group?.attrs || {},
    variables: arrays.map(({ name, array }) => describeVariable(name, array, group?.attrs || {})),
    coordinates,
    store,
  };
}

/** The parent group of a directly-named array, for its attrs and coordinates. */
async function openParentGroup(parentUrl, coordinates) {
  try {
    const parentStore = await zarrita.withMaybeConsolidatedMetadata(new zarrita.FetchStore(parentUrl));
    const parent = await zarrita.open(parentStore, { kind: "group" });
    for (const name of (await childNames(parentStore, parentUrl)) || []) {
      const array = await openArray(parentStore, name);
      if (array && array.shape.length === 1) coordinates.set(name, array);
    }
    return parent;
  } catch {
    return null;
  }
}

/* ---------- describing one array ---------- */

/**
 * Which axes are spatial.
 *
 * By name when the array says — `_ARRAY_DIMENSIONS` in v2, `dimension_names` in
 * v3 — and otherwise the last two, which is the row-major `(…, y, x)` order
 * every raster-shaped array in the wild uses. Guessing the last two is right
 * far more often than it is wrong, and the picker shows which axes were chosen
 * so a wrong guess is visible rather than silent.
 */
function spatialAxes(dims, shape) {
  const yAxis = dims.findIndex((name) => Y_DIMENSION_NAMES.has(String(name).toLowerCase()));
  const xAxis = dims.findIndex((name) => X_DIMENSION_NAMES.has(String(name).toLowerCase()));
  if (yAxis >= 0 && xAxis >= 0 && yAxis !== xAxis) return { yAxis, xAxis, named: true };
  return { yAxis: shape.length - 2, xAxis: shape.length - 1, named: false };
}

/** The static half of a variable's description — no reads, so no awaiting. */
function describeVariable(name, array, groupAttrs) {
  const shape = array.shape;
  const dims = array.dimensionNames || shape.map((_, axis) => `dim_${axis}`);
  const attrs = array.attrs || {};
  const { yAxis, xAxis, named } = spatialAxes(dims, shape);
  return {
    name,
    array,
    attrs,
    groupAttrs,
    dtype: array.dtype,
    shape,
    chunks: array.chunks,
    dims: dims.map(String),
    yAxis,
    xAxis,
    axesNamed: named,
    readable: shape.length >= 2 && Boolean(DUCKDB_TYPES[array.dtype]),
    // CF decoding. Applied, because not applying it reports raw counts as if
    // they were measurements; announced, because applying it silently would
    // leave no way to tell a scaled store from an unscaled one.
    scaleFactor: Number(attrs.scale_factor ?? 1) || 1,
    addOffset: Number(attrs.add_offset ?? 0) || 0,
    nodata: nodataFromAttributes(attrs, groupAttrs) ?? toNumber(array.fillValue),
  };
}

function toNumber(value) {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Read a whole 1-D coordinate array, or null when it is absurdly long. */
async function coordinateValues(array) {
  if (!array || array.shape[0] > 20_000_000) return null;
  const chunk = await zarrita.get(array, [null]);
  return Array.from(chunk.data, Number);
}

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
function medianStep(values) {
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

/*
 * Zarr metadata: recognising stores, reading attributes (CRS, nodata, affine),
 * discovering arrays and describing each variable's dimensions.
 */

import * as zarrita from "zarrita";
import { DUCKDB_TYPES } from "./flatten.js";

/** A store is a folder whose name ends in .zarr — there is no file to test. */
const STORE_SUFFIX = /\.zarr\/?$/i;

/** Dimension names that conventionally mean "down the rows" and "across". */
const Y_DIMENSION_NAMES = new Set(["y", "lat", "latitude", "northing", "row"]);
const X_DIMENSION_NAMES = new Set(["x", "lon", "long", "longitude", "easting", "col", "column"]);

/** Attributes that carry a CRS, in the order they are worth believing. */
const CRS_ATTRIBUTES = ["crs_wkt", "spatial_ref", "crs", "proj:wkt2", "esri_pe_string", "epsg"];

/** Attributes that mean "this value is not a measurement". */
const NODATA_ATTRIBUTES = ["_FillValue", "missing_value", "nodata", "nodatavals", "fill_value"];
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
export function crsFromAttributes(...attributeSets) {
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
export function affineFromAttributes(...attributeSets) {
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
export async function coordinateValues(array) {
  if (!array || array.shape[0] > 20_000_000) return null;
  const chunk = await zarrita.get(array, [null]);
  return Array.from(chunk.data, Number);
}

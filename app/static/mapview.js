/*
 * The geometry panel.
 *
 * Geometry comes out of DuckDB as WKB bytes and is decoded here, rather than
 * asking for ST_AsGeoJSON text: fewer bytes over the worker boundary and no
 * JSON parse per feature.
 *
 * There is no viewport-driven refetch. A viewer over precomputed tiles can page
 * geometry by tile; an arbitrary intermediate view in an ETL graph has no such
 * index, so this draws a capped
 * preview and says so rather than pretending to show everything.
 */

import maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm";

import { hasSpatial, query, qid, qlit } from "./duck.js";
import { H3_INDEX_COLUMN, cellToPolygon, parentIndexExpr, resolutionExpr } from "./h3.js";
import { findGeometryColumn, geometryExpression, wkbExpression, isLonLatCode, LONLAT } from "./schema.js";
import { decodeWKB } from "./wkb.js";

const DEFAULT_FEATURE_LIMIT = 8000;
/**
 * Beyond this, warn rather than just draw.
 *
 * MapLibre re-tiles a GeoJSON source on the main thread, so a few hundred
 * thousand polygons is a multi-second freeze rather than a slow map. The limit
 * is the user's to raise — but they should know what they are asking for.
 */
const SLOW_FEATURE_COUNT = 50_000;
const EMPTY = { type: "FeatureCollection", features: [] };

const BASEMAPS = {
  street: {
    label: "Street",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors",
  },
  aerial: {
    label: "Aerial",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  },
};

let map = null;
let statusEl = null;
// null means no cap. Set from the Geometry panel.
let featureLimit = DEFAULT_FEATURE_LIMIT;
// null draws every cell at its own resolution; a number rolls them up to it.
let coarsenResolution = null;
// Tells the app what resolution the current view's cells are, so it can offer
// the coarser ones — or null when the view holds no H3 index at all.
let onResolution = null;
// Resolves once the style has loaded and the data layers exist. Callers await
// it rather than a boolean flag, so geometry requested during startup still
// draws when the map catches up instead of being silently dropped.
let ready = null;

function styleFor(key) {
  const basemap = BASEMAPS[key];
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: basemap.tiles,
        tileSize: 256,
        attribution: basemap.attribution,
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

function addDataLayers() {
  if (map.getSource("features")) return;
  map.addSource("features", { type: "geojson", data: EMPTY });
  map.addSource("picked", { type: "geojson", data: EMPTY });
  // Colour comes off the feature, not the layer: several inspected nodes share
  // these three layers and are told apart by the palette entry each carries.
  const colour = ["coalesce", ["get", "_pv_color"], "#318150"];
  map.addLayer({
    id: "features-fill",
    type: "fill",
    source: "features",
    filter: BASE_FILTERS["features-fill"],
    paint: { "fill-color": colour, "fill-opacity": 0.35 },
  });
  map.addLayer({
    id: "features-line",
    type: "line",
    source: "features",
    filter: BASE_FILTERS["features-line"],
    paint: { "line-color": colour, "line-width": 1.4 },
  });
  map.addLayer({
    id: "features-point",
    type: "circle",
    source: "features",
    filter: BASE_FILTERS["features-point"],
    paint: {
      "circle-radius": 4,
      "circle-color": colour,
      "circle-stroke-color": "#0b2417",
      "circle-stroke-width": 1,
    },
  });
  applyHiddenFilter();

  // The row you clicked in the table, drawn over everything else.
  map.addLayer({
    id: "picked-fill",
    type: "fill",
    source: "picked",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#eca72c", "fill-opacity": 0.45 },
  });
  map.addLayer({
    id: "picked-line",
    type: "line",
    source: "picked",
    paint: { "line-color": "#c0563f", "line-width": 2.5 },
  });
  map.addLayer({
    id: "picked-point",
    type: "circle",
    source: "picked",
    filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 7, "circle-color": "#eca72c", "circle-stroke-color": "#c0563f", "circle-stroke-width": 2 },
  });
}

/** What each feature layer draws before visibility is taken into account. */
const BASE_FILTERS = {
  "features-fill": ["==", ["geometry-type"], "Polygon"],
  "features-line": ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]],
  "features-point": ["==", ["geometry-type"], "Point"],
};

/** Keys of the form "nodeId:portId" whose features are hidden. */
let hiddenKeys = [];

/**
 * Hide some inspected nodes without touching the data.
 *
 * A filter rather than a refetch: the features are already loaded, so turning a
 * sheet off is one setFilter call and turning it back on costs nothing. Only
 * the map is affected — the sheet keeps its rows.
 */
function applyHiddenFilter() {
  for (const [layerId, base] of Object.entries(BASE_FILTERS)) {
    if (!map?.getLayer(layerId)) continue;
    const filter = hiddenKeys.length
      ? ["all", base, ["!", ["in", ["get", "_pv_key"], ["literal", hiddenKeys]]]]
      : base;
    map.setFilter(layerId, filter);
  }
}

export async function setHiddenLayers(keys) {
  hiddenKeys = keys || [];
  await ready;
  applyHiddenFilter();
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message || "";
}

/** How many features to draw; null draws every one. */
export function setFeatureLimit(value) {
  featureLimit = value;
}

/** Roll H3 cells up to this resolution before drawing; null keeps full detail. */
export function setCoarsenResolution(value) {
  coarsenResolution = value;
}

function limitClause() {
  return featureLimit ? ` LIMIT ${featureLimit}` : "";
}

/** The trailing note on the status line: was anything left out, or is this slow? */
function volumeNote(drawn) {
  if (featureLimit && drawn === featureLimit) {
    return ` (capped at ${featureLimit.toLocaleString()} — raise the limit to draw more)`;
  }
  if (drawn >= SLOW_FEATURE_COUNT) return " — this many will make the map sluggish";
  return "";
}

function setData(featureCollection) {
  const source = map.getSource("features");
  if (source) source.setData(featureCollection);
}

function boundsOf(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      minX = Math.min(minX, coordinates[0]);
      maxX = Math.max(maxX, coordinates[0]);
      minY = Math.min(minY, coordinates[1]);
      maxY = Math.max(maxY, coordinates[1]);
      return;
    }
    for (const part of coordinates) visit(part);
  };
  for (const feature of features) {
    if (feature.geometry?.coordinates) visit(feature.geometry.coordinates);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function fitTo(bounds) {
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding: 24, duration: 0, maxZoom: 14 },
  );
}

/**
 * Whether a bounding box could plausibly be longitude/latitude.
 *
 * This is the runtime stand-in for CRS provenance. Tracking a CRS through
 * arbitrary transformers is a bigger job than v1 needs, but geometry in a
 * metre-based projection has coordinates in the hundreds of thousands, so it
 * announces itself the moment it is measured — and drawing it anyway would put
 * a Swiss field in the Gulf of Guinea.
 */
function looksLikeLonLat(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

/** Columns worth averaging when cells are rolled up. */
const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|U?BIGINT|U?INTEGER|U?SMALLINT|U?TINYINT|HUGEINT)/;

/** Every cell drawn as itself. */
async function fetchH3Detail(viewName, columns) {
  const attributes = columns
    .filter((column) => column.name !== H3_INDEX_COLUMN)
    .map((column) => qid(column.name));
  const selection = [qid(H3_INDEX_COLUMN), ...attributes].join(", ");
  return query(
    `SELECT ${selection} FROM ${viewName} WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL${limitClause()}`,
  );
}

/**
 * Cells rolled up to a coarser resolution.
 *
 * The grouping happens in DuckDB, so the whole tile is summarised without a
 * single extra row crossing into JavaScript — which is the only way to see all
 * of an 823,543-cell tile at once. Numeric attributes are averaged and the
 * child count is carried, so a hexagon still says something; anything
 * non-numeric is dropped rather than picked arbitrarily.
 */
async function fetchH3Coarse(viewName, columns, parentRes) {
  const parent = parentIndexExpr(H3_INDEX_COLUMN, parentRes);
  const averages = columns
    .filter((column) => column.name !== H3_INDEX_COLUMN && NUMERIC_TYPE.test(column.type))
    .map((column) => `avg(${qid(column.name)}) AS ${qid(column.name)}`);
  const selection = [`${parent} AS ${qid(H3_INDEX_COLUMN)}`, "count(*) AS cells", ...averages].join(", ");
  return query(
    `SELECT ${selection} FROM ${viewName} WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL
     GROUP BY 1${limitClause()}`,
  );
}

/**
 * Features for a view whose geometry lives in an H3 index.
 *
 * Boundaries are computed here, for what is actually drawn — never up front for
 * the whole tile, which for a res-6 dense tile would be 823,543 hexagons.
 */
async function h3Features(viewName, columns) {
  const detected = await query(
    `SELECT ${resolutionExpr(H3_INDEX_COLUMN)} AS res FROM ${viewName}
     WHERE ${qid(H3_INDEX_COLUMN)} IS NOT NULL LIMIT 1`,
  );
  const dataResolution = detected.length ? Number(detected[0].res) : null;

  const coarse = coarsenResolution !== null && dataResolution !== null && coarsenResolution < dataResolution;
  const rows = coarse
    ? await fetchH3Coarse(viewName, columns, coarsenResolution)
    : await fetchH3Detail(viewName, columns);

  const features = [];
  let failed = 0;
  for (const row of rows) {
    try {
      features.push({ type: "Feature", geometry: cellToPolygon(row[H3_INDEX_COLUMN]), properties: row });
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn("Could not build a hexagon from an H3 index", err);
    }
  }

  const capped = volumeNote(rows.length);
  const skipped = failed ? ` · ${failed} could not be built` : "";
  const note = coarse
    ? `${features.length.toLocaleString()} hexagons at res ${coarsenResolution}, rolled up from ` +
      `${rows.reduce((total, row) => total + Number(row.cells || 0), 0).toLocaleString()} cells${capped}${skipped}`
    : `${features.length.toLocaleString()} H3 cells${capped}${skipped}`;
  return { features, note, resolution: dataResolution };
}

/** Features for a view with a real geometry column. */
async function geometryFeatures(viewName, columns, geometry, crs = LONLAT) {
  if (geometry.kind === "geometry" && !hasSpatial()) {
    // Without it, ST_AsWKB is not in the catalog and the query below fails with
    // a message about installing an extension, which is not the user's problem.
    return { features: [], note: "the spatial extension did not load" };
  }

  const attributeColumns = columns
    .filter((column) => column.name !== geometry.name)
    .map((column) => qid(column.name));
  /*
   * A Reprojector upstream means these coordinates are not lon/lat, and
   * MapLibre only speaks lon/lat — so the stream comes home for drawing only.
   * The data itself is left where the user put it; this is the display copy.
   */
  const drawable = isLonLatCode(crs)
    ? wkbExpression(geometry)
    : `ST_AsWKB(ST_Transform(${geometryExpression(geometry)}, ${qlit(crs)}, ${qlit(LONLAT)}, always_xy := true))`;
  const selection = [`${drawable} AS _wkb`, ...attributeColumns].join(", ");
  const rows = await query(
    `SELECT ${selection} FROM ${viewName} WHERE ${qid(geometry.name)} IS NOT NULL${limitClause()}`,
  );

  const features = [];
  let failed = 0;
  for (const row of rows) {
    const { _wkb: wkb, ...properties } = row;
    try {
      features.push({ type: "Feature", geometry: decodeWKB(wkb), properties });
    } catch (err) {
      failed += 1;
      if (failed === 1) console.warn("Could not decode a geometry", err);
    }
  }

  const bounds = boundsOf(features);
  if (bounds && !looksLikeLonLat(bounds)) {
    // A declared CRS is reprojected at the Reader and a Reprojector's is
    // undone just above, so reaching here means the file declared none — the
    // one case the app still cannot resolve on its own.
    return {
      features: [],
      note:
        `not longitude/latitude (x ${Math.round(bounds[0])}…${Math.round(bounds[2])}) and no CRS ` +
        "declared — set a CRS override on the Reader",
    };
  }

  const capped = volumeNote(rows.length);
  const skipped = failed ? ` · ${failed} could not be decoded` : "";
  return { features, note: `${features.length.toLocaleString()} features${capped}${skipped}` };
}

/**
 * Draw one or several inspected nodes together.
 *
 * Everything goes into a single GeoJSON source with the colour carried on each
 * feature, and the paint reads it back with ["get", …]. One source per node
 * would mean adding and removing layers as the selection changes, and a stack
 * of sources whose draw order nobody controls; this way the map is always three
 * layers and the styling is data.
 *
 * @param targets [{ key, nodeId, portId, label, view, columns, color }]
 */
export async function showGeometries(targets) {
  await ready;
  if (!targets.length) {
    onResolution?.(null);
    setData(EMPTY);
    setStatus("Select a node.");
    return;
  }

  const all = [];
  const notes = [];
  let resolution = null;
  for (const target of targets) {
    const geometry = findGeometryColumn(target.columns);
    const isH3 = !geometry && target.columns.some((column) => column.name === H3_INDEX_COLUMN);
    let result;
    if (geometry) {
      result = await geometryFeatures(target.view, target.columns, geometry, target.crs || LONLAT);
    } else if (isH3) {
      result = await h3Features(target.view, target.columns);
      if (resolution === null) resolution = result.resolution ?? null;
    } else {
      result = { features: [], note: "no geometry" };
    }
    for (const feature of result.features) {
      // _pv_key, not the label: the visibility filter keys on identity, and
      // two nodes can perfectly well end up with the same label.
      feature.properties = {
        ...feature.properties,
        _pv_color: target.color,
        _pv_layer: target.label,
        _pv_key: target.key,
      };
    }
    all.push(...result.features);
    notes.push(targets.length > 1 ? `${target.label}: ${result.note}` : result.note);
  }

  // The coarsen control only makes sense for a single H3 view.
  onResolution?.(targets.length === 1 ? resolution : null);

  setData({ type: "FeatureCollection", features: all });
  applyHiddenFilter();
  // Fit to what is actually shown, so hiding a distant layer zooms back in.
  const visible = hiddenKeys.length
    ? all.filter((feature) => !hiddenKeys.includes(feature.properties._pv_key))
    : all;
  const bounds = boundsOf(visible.length ? visible : all);
  if (bounds) fitTo(bounds);
  setStatus(notes.join(" · "));
}

/**
 * Zoom to one feature, picked from the attribute table.
 *
 * The geometry arrives with the row rather than being looked up here, so this
 * is pure display: decode, highlight, fit. A point gets a zoom level instead of
 * a bounding box, since a degenerate box would fit to maximum zoom.
 */
export async function zoomToFeature(pick) {
  await ready;
  if (!pick?.value) return;
  let geometry;
  try {
    geometry = pick.kind === "h3" ? cellToPolygon(pick.value) : decodeWKB(pick.value);
  } catch (err) {
    console.warn("Could not decode the picked feature", err);
    return;
  }
  const feature = { type: "Feature", geometry, properties: {} };
  map.getSource("picked")?.setData({ type: "FeatureCollection", features: [feature] });

  const bounds = boundsOf([feature]);
  if (!bounds) return;
  if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
    map.easeTo({ center: [bounds[0], bounds[1]], zoom: Math.max(map.getZoom(), 15), duration: 400 });
    return;
  }
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding: 80, duration: 400, maxZoom: 17 },
  );
}

/** Drop the picked-feature highlight, e.g. when the inspected node changes. */
export async function clearPicked() {
  await ready;
  map.getSource("picked")?.setData(EMPTY);
}

export async function clearMap(message) {
  setStatus(message || "");
  onResolution?.(null);
  await ready;
  setData(EMPTY);
}

export function resizeMap() {
  map?.resize();
}

/**
 * Create the map. Returns immediately — the caller must not wait for it.
 *
 * MapLibre does not fire `load` while its tab is hidden, so awaiting startup
 * here would hang the whole app in a background tab. The map catches up on its
 * own; nothing else depends on it.
 */
export function initMap(container, status, basemapSelect, handlers = {}) {
  statusEl = status;
  onResolution = handlers.onResolution || null;
  map = new maplibregl.Map({
    container,
    style: styleFor("street"),
    center: [0, 20],
    zoom: 1.4,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  basemapSelect.replaceChildren();
  for (const [key, basemap] of Object.entries(BASEMAPS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = basemap.label;
    basemapSelect.appendChild(option);
  }
  basemapSelect.addEventListener("change", (event) => {
    // setStyle drops every layer, so the data layers have to be put back once
    // the new style has finished loading.
    map.setStyle(styleFor(event.target.value));
    map.once("styledata", addDataLayers);
  });

  map.on("click", "features-fill", (event) => showPopup(event));
  map.on("click", "features-point", (event) => showPopup(event));

  // `styledata`, not `load`. Adding a source and layers needs only the style;
  // `load` additionally waits for the first frame to be painted, and a browser
  // does not paint a hidden tab — so gating on it leaves the map permanently
  // empty in a background tab and only "fixes itself" when someone looks at it.
  ready = new Promise((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once("styledata", resolve);
  }).then(addDataLayers);
  return ready;
}

function showPopup(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  const rows = Object.entries(feature.properties || {})
    .slice(0, 20)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join("");
  new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat(event.lngLat)
    .setHTML(`<table class="popup">${rows}</table>`)
    .addTo(map);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

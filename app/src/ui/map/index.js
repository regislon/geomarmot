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

export { setHiddenLayers } from "./layers.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { LONLAT, findGeometryColumn } from "../../core/schema.js";
import { decodeWKB } from "../../core/wkb.js";
import { H3_INDEX_COLUMN, cellToPolygon } from "../../engines/h3/index.js";
import maplibregl from "maplibre-gl";
import { geometryFeatures, h3Features } from "./features.js";
import { addDataLayers, applyHiddenFilter, hiddenKeys, styleFor } from "./layers.js";

const DEFAULT_FEATURE_LIMIT = 8000;
/**
 * Beyond this, warn rather than just draw.
 *
 * MapLibre re-tiles a GeoJSON source on the main thread, so a few hundred
 * thousand polygons is a multi-second freeze rather than a slow map. The limit
 * is the user's to raise — but they should know what they are asking for.
 */
export const SLOW_FEATURE_COUNT = 50_000;
export const EMPTY = { type: "FeatureCollection", features: [] };

export const BASEMAPS = {
  street: {
    label: "Street",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors",
  },
  aerial: {
    label: "Aerial",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  },
};

export let map = null;
let statusEl = null;
// null means no cap. Set from the Geometry panel.
export let featureLimit = DEFAULT_FEATURE_LIMIT;
// null draws every cell at its own resolution; a number rolls them up to it.
export let coarsenResolution = null;
// Tells the app what resolution the current view's cells are, so it can offer
// the coarser ones — or null when the view holds no H3 index at all.
let onResolution = null;
// Resolves once the style has loaded and the data layers exist. Callers await
// it rather than a boolean flag, so geometry requested during startup still
// draws when the map catches up instead of being silently dropped.
export let ready = null;
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

function setData(featureCollection) {
  const source = map.getSource("features");
  if (source) source.setData(featureCollection);
}

export function boundsOf(features) {
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
  const visible = hiddenKeys.length ? all.filter((feature) => !hiddenKeys.includes(feature.properties._pv_key)) : all;
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

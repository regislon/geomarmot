/* The map's basemap styles, its three shared data layers, and hiding inspected outputs. */

import { BASEMAPS, EMPTY, map, ready } from "./index.js";

export function styleFor(key) {
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

export function addDataLayers() {
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
  // A dot for each small polygon or line while zoomed out, where its shape would be a pixel or less.
  map.addLayer({
    id: "features-marker",
    type: "circle",
    source: "features",
    maxzoom: MARKER_MAX_ZOOM,
    filter: BASE_FILTERS["features-marker"],
    paint: {
      "circle-radius": 4,
      "circle-color": colour,
      "circle-opacity": 0.8,
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
    paint: {
      "circle-radius": 7,
      "circle-color": "#eca72c",
      "circle-stroke-color": "#c0563f",
      "circle-stroke-width": 2,
    },
  });
}

/** What each feature layer draws before visibility is taken into account. */
const BASE_FILTERS = {
  "features-fill": ["==", ["geometry-type"], "Polygon"],
  "features-line": ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]],
  "features-point": ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "_pv_marker"]]],
  "features-marker": ["has", "_pv_marker"],
};

/** Below this zoom, small shapes also get a dot; from it on, their own outline is big enough to see. */
const MARKER_MAX_ZOOM = 8;
/** A shape whose extent is under this many degrees each way (about 100 km) counts as small. */
const SMALL_DEGREES = 1;

/**
 * A dot at the middle of each small polygon or line. A 15 km buffer drawn on a
 * world map is a pixel; points stay visible at any zoom because they are drawn
 * at a fixed size, so small shapes are given the same, until zoomed in.
 */
export function markersFor(features, boundsOf) {
  const markers = [];
  for (const feature of features) {
    const type = feature.geometry?.type;
    if (!type || type === "Point" || type === "MultiPoint") continue;
    const bounds = boundsOf([feature]);
    if (!bounds || bounds[2] - bounds[0] > SMALL_DEGREES || bounds[3] - bounds[1] > SMALL_DEGREES) continue;
    markers.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] },
      properties: { ...feature.properties, _pv_marker: true },
    });
  }
  return markers;
}

/** Keys of the form "nodeId:portId" whose features are hidden. */
export let hiddenKeys = [];

/**
 * Hide some inspected nodes without touching the data.
 *
 * A filter rather than a refetch: the features are already loaded, so turning a
 * sheet off is one setFilter call and turning it back on costs nothing. Only
 * the map is affected — the sheet keeps its rows.
 */
export function applyHiddenFilter() {
  for (const [layerId, base] of Object.entries(BASE_FILTERS)) {
    if (!map?.getLayer(layerId)) continue;
    const filter = hiddenKeys.length ? ["all", base, ["!", ["in", ["get", "_pv_key"], ["literal", hiddenKeys]]]] : base;
    map.setFilter(layerId, filter);
  }
}

export async function setHiddenLayers(keys) {
  hiddenKeys = keys || [];
  await ready;
  applyHiddenFilter();
}

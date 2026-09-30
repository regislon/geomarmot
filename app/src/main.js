/*
 * Wiring.
 *
 * Holds no logic of its own beyond orchestration: sources register files,
 * graph.js compiles views, canvas.js draws, table.js and mapview.js inspect.
 * Two behaviours are genuinely load-bearing and live here — the debounce that
 * keeps a keystroke from recompiling the whole graph, and the sequence guard
 * that stops a slow query for a node you have already clicked away from
 * overwriting the panel for the node you are now looking at.
 */

import { boot } from "./core/duck.js";
import { clear as clearGraph, graph } from "./core/graph/index.js";
import { setProgressReporter } from "./engines/h3/index.js";
import { setOverlayProgress } from "./engines/jsts.js";
import { setProgressReporter as setZarrProgress } from "./io/zarr/index.js";
import { initBrowser, openBrowser } from "./ui/browser.js";
import { arrange, initCanvas, render as renderCanvas, select as selectNode, setInspected } from "./ui/canvas/index.js";
import {
  initMap,
  resizeMap,
  setCoarsenResolution,
  setFeatureLimit,
  setHiddenLayers,
  zoomToFeature,
} from "./ui/map/index.js";
import { initProgress } from "./ui/progress.js";
import { initSheetPicker } from "./ui/sheetpicker.js";
import { initTable } from "./ui/table.js";
import { initZarrPicker } from "./ui/zarrpicker.js";
import { onGraphChange, recompile } from "./ui/compile-loop.js";
import { initDockResizer, initDockSplitter } from "./ui/dock.js";
import { el, setStatus } from "./ui/dom.js";
import { initDropZone } from "./ui/dragdrop.js";
import { connectedWriters, exportWriters } from "./ui/export.js";
import { initHistory, resetHistoryBaseline, updateHistoryButtons } from "./ui/history.js";
import {
  hiddenLayers,
  inspectedKeys,
  inspectionColours,
  legendTargets,
  refreshInspection,
  refreshInspector,
  renderCoarsenSelect,
  renderLegend,
  setHiddenLayerKeys,
  setInspectedKeys,
} from "./ui/inspect.js";
import { initGeometryModal, initHelpModal, showGeometryInfo } from "./ui/modals.js";
import { autosave, exportGraph, importGraph, restoreAutosave } from "./ui/persistence.js";
import { initQuickAdd } from "./ui/quickadd.js";
import { addZarrSource, loadUrl, renderPalette, renderSources } from "./ui/rail.js";
import { initAssistant } from "./ui/assistant/index.js";
import { setProxyAvailable } from "./io/remote.js";
import { installStoredCustoms, onCustomInstalled } from "./ai/spec/install.js";

/* ---------- boot ---------- */

/**
 * Exchange the launch token for a session, when the local server gave us one.
 *
 * The `geomarmot` command opens the app at `/#t=<token>`. The token is taken
 * out of the address bar at once, then traded for an HttpOnly session cookie
 * that the proxy, the bucket listing and DuckDB's own range requests all carry.
 * Served without that server (a static host), there is no token and nothing
 * to do.
 */
async function openSession() {
  const match = window.location.hash.match(/(?:^#|&)t=([^&]+)/);
  if (!match) return;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    const response = await fetch(new URL("session", window.location.href), {
      method: "POST",
      headers: { "X-GeoMarmot-Token": decodeURIComponent(match[1]) },
    });
    if (!response.ok) setStatus("This link's session has expired — open the one the geomarmot command printed.", true);
  } catch (err) {
    console.warn("Could not open a session with the local server", err);
  }
}

/**
 * Is the local server behind this page? On a static host (GitHub Pages)
 * ./healthz does not answer: the bucket browser is hidden and gs:// paths say
 * why they cannot work.
 */
async function detectServer() {
  let proxy = false;
  try {
    const response = await fetch(new URL("healthz", window.location.href));
    const body = response.ok ? await response.json() : null;
    proxy = body?.status === "ok" && body.proxy === true;
  } catch {
    /* no server */
  }
  setProxyAvailable(proxy);
  el("btn-browse").hidden = !proxy;
}

async function main() {
  await openSession();
  await detectServer();
  initTable({
    head: el("table-head"),
    body: el("table-body"),
    meta: el("table-meta"),
    prev: el("table-prev"),
    next: el("table-next"),
    tabs: el("sheet-tabs"),
    onSheetChange: () => refreshInspector(),
    onInfo: (pick) => showGeometryInfo(pick),
    // Visibility is a map concern only — the sheet keeps its rows either way,
    // so this never re-queries.
    onVisibility: (allSheets) => {
      setHiddenLayerKeys(allSheets.filter((sheet) => sheet.visible === false).map((sheet) => sheet.key));
      setHiddenLayers(hiddenLayers).catch((err) => console.warn("Layer visibility", err));
      // The legend shows the same state, so it follows the swatch too. Read
      // back from hiddenLayers rather than trusting either control's own copy.
      for (const target of legendTargets) target.visible = !hiddenLayers.includes(target.key);
      renderLegend();
    },
    onPick: (pick) => zoomToFeature(pick).catch((err) => console.warn("Zoom to feature failed", err)),
  });
  initCanvas(el("canvas"), {
    onSelect: () => {
      refreshInspector();
      refreshInspection().catch((err) => setStatus(err.message, true));
    },
    onInspect: (key, { add } = {}) => {
      if (add) {
        // Shift-click: toggle this output in or out of the compared set.
        setInspectedKeys(
          inspectedKeys.includes(key) ? inspectedKeys.filter((other) => other !== key) : [...inspectedKeys, key],
        );
      } else {
        // Plain click: this output alone, or unpin if it already was the only one.
        const only = inspectedKeys.length === 1 && inspectedKeys[0] === key;
        setInspectedKeys(only ? [] : [key]);
      }
      setInspected(inspectionColours());
      refreshInspection().catch((err) => setStatus(err.message, true));
    },
    onChange: onGraphChange,
    onLayoutChange: autosave,
  });
  renderPalette();
  onCustomInstalled(() => renderPalette());
  renderSources();
  initDropZone();
  initDockResizer();
  initDockSplitter();
  initHelpModal();
  initGeometryModal();
  initQuickAdd();
  initHistory();
  initAssistant();
  // Building a full tile's hexagons takes long enough to need saying so.
  setProgressReporter((message) => setStatus(message));
  setOverlayProgress((message) => setStatus(message));
  // Reading a Zarr window is chunk-by-chunk over the network; it needs saying so.
  setZarrProgress((message) => setStatus(message || ""));

  el("btn-export").addEventListener("click", () => exportWriters(connectedWriters()));
  el("btn-arrange").addEventListener("click", arrange);
  el("btn-export-graph").addEventListener("click", exportGraph);
  el("btn-import-graph").addEventListener("click", () => el("graph-input").click());
  el("graph-input").addEventListener("change", (event) => {
    if (event.target.files[0]) importGraph(event.target.files[0]);
  });
  el("btn-clear").addEventListener("click", () => {
    clearGraph();
    setInspectedKeys([]);
    setInspected(new Map());
    renderCanvas();
    selectNode(null);
    onGraphChange();
  });
  el("btn-load-url").addEventListener("click", () => loadUrl(el("url-input").value));
  initBrowser({
    modal: el("browse-modal"),
    bucket: el("browse-bucket"),
    go: el("browse-go"),
    close: el("browse-close"),
    path: el("browse-path"),
    list: el("browse-list"),
    note: el("browse-note"),
    onPick: (gsPath) => loadUrl(gsPath, { clearInput: false }),
  });
  el("btn-browse").addEventListener("click", () => openBrowser());
  initZarrPicker({
    modal: el("zarr-modal"),
    title: el("zarr-title"),
    variables: el("zarr-variables"),
    plan: el("zarr-plan"),
    note: el("zarr-note"),
    add: el("zarr-add"),
    close: el("zarr-close"),
    onAdd: addZarrSource,
  });
  initProgress({ root: el("progress"), label: el("progress-label"), fill: el("progress-fill") });
  initSheetPicker({
    modal: el("sheet-modal"),
    title: el("sheet-title"),
    hint: el("sheet-hint"),
    body: el("sheet-body"),
    back: el("sheet-back"),
    add: el("sheet-add"),
    close: el("sheet-close"),
  });
  el("url-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadUrl(el("url-input").value);
  });
  el("limit-select").addEventListener("change", (event) => {
    // Empty value is the "No limit" option.
    setFeatureLimit(event.target.value ? Number(event.target.value) : null);
    refreshInspection().catch((err) => setStatus(err.message, true));
  });
  el("coarsen-select").addEventListener("change", (event) => {
    // Empty value is "Full detail".
    setCoarsenResolution(event.target.value === "" ? null : Number(event.target.value));
    refreshInspection().catch((err) => setStatus(err.message, true));
  });
  window.addEventListener("resize", resizeMap);

  // Deliberately not awaited: MapLibre withholds `load` in a hidden tab, and
  // the data engine must not wait on the scenery.
  initMap("map", el("map-status"), el("basemap-select"), { onResolution: renderCoarsenSelect });
  await boot();
  // Generated transformers first: the autosaved graph may use them.
  await installStoredCustoms();
  await restoreAutosave();
  renderPalette();
  // The restored graph is the baseline; undo should not walk back past it into
  // an empty canvas the user never saw.
  resetHistoryBaseline();
  updateHistoryButtons();
  await recompile();
  setStatus(graph.nodes.length ? "Restored your last graph." : "Drop a file to start.");
}

main().catch((err) => setStatus(`Startup failed: ${err.message}`, true));

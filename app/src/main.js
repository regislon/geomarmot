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

import { boot, query } from "./core/duck.js";
import { memoryLimit } from "./core/memory.js";
import { initMemoryMeter } from "./ui/memory-meter.js";
import { clear as clearGraph, graph } from "./core/graph/index.js";
import { setProgressReporter } from "./engines/h3/index.js";
import { setOverlayProgress } from "./engines/jsts.js";
import { setProgressReporter as setZarrProgress } from "./io/zarr/index.js";
import { initConnectors, openConnect } from "./ui/connectors/index.js";
import { arrange, initCanvas, render as renderCanvas, select as selectNode, setInspected } from "./ui/canvas/index.js";
import {
  initMap,
  resizeMap,
  setCoarsenResolution,
  setFeatureLimit,
  setHiddenLayers,
  zoomToFeature,
} from "./ui/map/index.js";
import { initProgress, reportProgress, withProgress } from "./ui/progress.js";
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
import { addZarrSource, loadFiles, loadUrl, renderPalette, renderSources } from "./ui/rail.js";
import { initAssistant } from "./ui/assistant/index.js";
import { initMenu } from "./ui/menu.js";
import { detachWorkspace, initWorkspaces, openFromBrowser, saveToBrowser } from "./ui/workspaces.js";
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
 * ./healthz does not answer: the bucket connector and gs:// paths say why they
 * cannot work.
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
}

/** Which engine runs the graph, and how much memory it may use: the limit large files hit first. */
async function showEngine() {
  const [{ v }] = await query("SELECT version() AS v").catch(() => [{ v: "" }]);
  const info = el("engine-info");
  info.textContent = `DuckDB ${v} in this browser · memory up to ${memoryLimit().replace("GB", " GB")}`;
  info.title =
    "The engine is 32-bit WebAssembly: at most 4 GB on any machine, and it cannot spill to disk. For larger data, convert to Parquet, or see issue #1 (a native engine through the local server).";
}

/** Shown in turn while the engine starts. */
const WAKING = [
  "Waking the marmot from hibernation…",
  "Stretching after a long winter…",
  "Sniffing the morning air…",
  "Clearing the burrow entrance…",
  "Digging the first tunnels…",
  "Checking the sky for eagles…",
  "Whistling to the colony…",
];

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
  // Building hexagons, noding polygons and reading Zarr chunks take long enough to need a bar.
  setProgressReporter(reportProgress);
  setOverlayProgress(reportProgress);
  setZarrProgress(reportProgress);

  el("btn-export").addEventListener("click", () => exportWriters(connectedWriters()));
  el("btn-arrange").addEventListener("click", arrange);
  initWorkspaces();
  const openFile = () => el("graph-input").click();
  initMenu("btn-open", "btn-open-menu", { "menu-open-computer": openFile, "menu-open-browser": openFromBrowser });
  initMenu("btn-save", "btn-save-menu", {
    "menu-save-computer": exportGraph,
    "menu-save-browser": () => saveToBrowser(),
    "menu-save-browser-as": () => saveToBrowser({ ask: true }),
  });
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
    for (const hint of document.querySelectorAll(".menu-list kbd, #toolbar [title]")) {
      const attr = hint.tagName === "KBD" ? "textContent" : "title";
      hint[attr] = hint[attr].replace("⇧⌘", "Ctrl+Shift+").replace("⌘", "Ctrl+");
    }
  }
  // The usual shortcuts, in place of the browser's own save-page and open-file: the quick ones save
  // to and open from this browser; a file download is one menu away.
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      saveToBrowser({ ask: event.shiftKey });
    } else if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      openFromBrowser();
    }
  });
  el("graph-input").addEventListener("change", (event) => {
    if (!event.target.files[0]) return;
    detachWorkspace();
    importGraph(event.target.files[0]);
    event.target.value = "";
  });
  el("btn-new").addEventListener("click", () => {
    if (graph.nodes.length && !window.confirm("Start an empty workspace? The current graph stays in Undo.")) return;
    detachWorkspace();
    clearGraph();
    setInspectedKeys([]);
    setInspected(new Map());
    renderCanvas();
    selectNode(null);
    onGraphChange();
  });
  initConnectors({
    modal: el("connect-modal"),
    list: el("connect-list"),
    close: el("connect-close"),
    panes: {
      computer: el("connector-computer"),
      gcs: el("connector-gcs"),
      url: el("connector-url"),
      database: el("connector-database"),
    },
    computer: {
      files: el("computer-files"),
      folder: el("computer-folder"),
      reopen: el("computer-reopen"),
      path: el("computer-path"),
      list: el("computer-list"),
      note: el("computer-note"),
    },
    gcs: {
      bucket: el("browse-bucket"),
      recent: el("browse-buckets"),
      go: el("browse-go"),
      path: el("browse-path"),
      list: el("browse-list"),
      note: el("browse-note"),
      google: {
        root: el("gcs-google"),
        text: el("gcs-google-text"),
        clientRow: el("gcs-client-row"),
        clientInput: el("gcs-client-id"),
        clientSave: el("gcs-client-save"),
        change: el("gcs-client-change"),
        signIn: el("gcs-sign-in"),
        signOut: el("gcs-sign-out"),
        help: el("gcs-client-help"),
        helpModal: el("gcs-help-modal"),
        helpClose: el("gcs-help-close"),
        helpOrigin: el("gcs-help-origin"),
      },
    },
    urlInput: el("url-input"),
    urlGo: el("btn-load-url"),
    urlRecent: el("url-recent"),
    onFiles: (files, options) => loadFiles(files, null, options),
    onUrl: loadUrl,
    chooseFiles: () => el("file-input").click(),
  });
  el("btn-connect").addEventListener("click", () => openConnect());
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
  initProgress({
    root: el("progress"),
    label: el("progress-label"),
    fill: el("progress-fill"),
    percent: el("progress-percent"),
  });
  initSheetPicker({
    modal: el("sheet-modal"),
    title: el("sheet-title"),
    hint: el("sheet-hint"),
    body: el("sheet-body"),
    back: el("sheet-back"),
    add: el("sheet-add"),
    close: el("sheet-close"),
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
  await withProgress(
    WAKING[0],
    async (task) => {
      // The engine takes a few seconds to start: the marmot narrates.
      let line = 0;
      const narrate = setInterval(() => task.update(WAKING[(line = (line + 1) % WAKING.length)], null), 1600);
      try {
        await boot();
        showEngine();
        initMemoryMeter();
      } finally {
        clearInterval(narrate);
      }
      task.update("Restoring your last graph…", null);
      // Generated transformers first: the autosaved graph may use them.
      await installStoredCustoms();
      await restoreAutosave();
      renderPalette();
      // The restored graph is the baseline; undo should not walk back past it into
      // an empty canvas the user never saw.
      resetHistoryBaseline();
      updateHistoryButtons();
      await recompile();
    },
    { delay: 0 },
  );
  setStatus(graph.nodes.length ? "Restored your last graph." : "Drop a file to start.");
}

main().catch((err) => setStatus(`Startup failed: ${err.message}`, true));

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
import {
  graph,
  addNode,
  nodeById,
  compile,
  validate,
  inputPorts,
  outputPorts,
  removeNode,
  upstreamView,
  upstreamCrs,
  serialize,
  load as loadGraph,
  clear as clearGraph,
} from "./core/graph.js";
import {
  initCanvas,
  render as renderCanvas,
  setIssues,
  setPortCounts,
  setInspected,
  select as selectNode,
  selected,
  arrange,
  screenToWorld,
} from "./ui/canvas.js";
import { renderInspector } from "./ui/inspector.js";
import { initTable, showSheets, clearTable, setSheetVisible, currentSheet } from "./ui/table.js";
import { describeFeature, renderFeature } from "./ui/geominfo.js";
import {
  initMap,
  showGeometries,
  clearMap,
  resizeMap,
  setFeatureLimit,
  setCoarsenResolution,
  setHiddenLayers,
  zoomToFeature,
  clearPicked,
} from "./ui/mapview.js";
import { sources, addLocalFile, addRemoteFile, addZarrLayer, isSupportedFile, removeSource } from "./io/sources.js";
import { TRANSFORMERS, PALETTE_GROUPS, searchTransformers } from "../../transformers/legacy.js";
import { setProgressReporter } from "./engines/h3.js";
import { setOverlayProgress } from "./engines/jsts.js";
import { inspectColour } from "./ui/palette.js";
import { initBrowser, openBrowser } from "./ui/browser.js";
import { isZarrPath, setProgressReporter as setZarrProgress } from "./io/zarr.js";
import { initZarrPicker, openZarrPicker } from "./ui/zarrpicker.js";
import { initSheetPicker, pickSheets } from "./ui/sheetpicker.js";
import { initProgress } from "./ui/progress.js";
import { describe, isLonLat, LONLAT } from "./core/schema.js";
import { runWriter } from "./io/writer.js";

const AUTOSAVE_KEY = "geomarmot:graph.v1";
const RECOMPILE_DEBOUNCE_MS = 220;
const NODES_PER_ROW = 4;

const el = (id) => document.getElementById(id);

let views = new Map();
// Which coordinate system each node's output is in, so the map can bring a
// reprojected stream home for drawing and a Writer knows what it is holding.
let crsByNode = new Map();
// nodeId -> the output port its sheet shows. Remembered per node so switching
// between sheets does not reset a Tester back to its "passed" port.
/*
 * What the bottom panels are pinned to: "nodeId:portId" keys, one per inspected
 * output. Keyed by port rather than by node because a Tester has two things
 * leaving it and both are worth seeing at once.
 */
// Inspected nodes whose features are hidden on the map; the sheet still shows
// its rows. Survives a rebuild so a hidden layer stays hidden.
let hiddenLayers = [];
/** The outputs the map is drawing — the legend and the sheet tabs share these. */
let legendTargets = [];
// Nodes the eye is pinned to, in the order they were added — that order is what
// assigns their colours. Empty means the panels follow the selection.
let inspectedKeys = [];
// Monotonic ticket for inspection queries. Clicking through nodes faster than
// DuckDB answers is normal; without this the slowest reply wins the panel.
let inspectSeq = 0;
let recompileTimer = null;
let compileInFlight = null;

function setStatus(message, isError = false) {
  const status = el("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  if (isError) console.error(message);
}

/* ---------- sources ---------- */

function h3Badge(h3) {
  if (h3.mode === "none") {
    return `<span class="badge warn" title="${h3.note}">H3 name, no index</span>`;
  }
  // In column mode the child resolution is whatever the column says, which we
  // have not queried — so label it by where the index came from, not by a
  // resolution we would be guessing at.
  if (h3.mode === "column") {
    return `<span class="badge geo" title="Parent ${h3.parent} — index from the &quot;${h3.column}&quot; column">H3 index</span>`;
  }
  return `<span class="badge geo" title="Parent ${h3.parent} — index from row order">H3 res ${h3.resolution}</span>`;
}

function sourceBadges(source) {
  const badges = [];
  if (source.geometry) {
    badges.push(`<span class="badge geo">geometry</span>`);
  } else if (source.h3) {
    badges.push(h3Badge(source.h3));
  }
  const crs = source.crs;
  if ((source.geometry || source.h3?.mode !== "none") && crs) {
    if (crs.assumed) {
      badges.push(
        `<span class="badge warn" title="The file declares no CRS, so it is taken as lon/lat. Set a CRS override on the Reader if that is wrong.">${crs.code}?</span>`,
      );
    } else if (!isLonLat(crs)) {
      // Any Reader on this source reprojects it, so say so here rather than
      // leaving a bare projected CRS looking like a problem. `display` is set
      // when the code itself is a whole WKT — too long for a badge.
      badges.push(
        `<span class="badge" title="Reprojected to lon/lat when read — ${crs.code}">${crs.display || crs.code} → 4326</span>`,
      );
    } else {
      badges.push(`<span class="badge">${crs.display || crs.code}</span>`);
    }
  }
  badges.push(`<span class="badge">${source.origin}</span>`);
  return badges.join("");
}

function renderSources() {
  const list = el("source-list");
  list.replaceChildren();
  if (!sources.size) {
    list.innerHTML = `<p class="muted">No files loaded yet.</p>`;
    return;
  }
  for (const source of sources.values()) {
    const card = document.createElement("div");
    card.className = "source";
    card.innerHTML =
      `<div class="source-head"><div class="source-name">${source.name}</div></div>` +
      `<div class="source-meta">${source.rows.toLocaleString()} rows · ${source.columns.length} columns</div>` +
      `<div>${sourceBadges(source)}</div>`;

    const remove = document.createElement("button");
    remove.className = "icon-btn source-remove";
    remove.textContent = "×";
    // Not a live count: the rail is only re-rendered when sources change, so a
    // number baked in here would be wrong the moment a Reader is added.
    remove.title = "Remove this layer and any Readers using it";
    remove.addEventListener("click", () => {
      removeLayer(source).catch((err) => setStatus(err.message, true));
    });
    card.querySelector(".source-head").appendChild(remove);

    const button = document.createElement("button");
    button.className = "add-btn";
    button.textContent = "+ Reader";
    button.style.marginTop = "6px";
    button.addEventListener("click", () => {
      const node = placeNode("Reader");
      node.params.sourceId = source.id;
      selectNode(node.id);
      onGraphChange();
    });
    card.appendChild(button);
    list.appendChild(card);
  }
}

/**
 * Drop a layer: its card, and every Reader on the canvas that was reading it.
 *
 * Leaving the Readers behind would just litter the graph with nodes that can
 * only report "choose a file". Undo brings the nodes back but not the file —
 * the same split as reopening a saved graph, where the recipe survives and the
 * data has to be supplied again.
 */
async function removeLayer(source) {
  const readers = graph.nodes.filter((node) => node.type === "Reader" && node.params.sourceId === source.id);
  for (const reader of readers) {
    const pinnedHere = inspectedKeys.filter((key) => splitKey(key).nodeId === reader.id);
    if (pinnedHere.length) {
      inspectedKeys = inspectedKeys.filter((key) => !pinnedHere.includes(key));
      setInspected(inspectionColours());
    }
    if (selected() === reader.id) selectNode(null);
    removeNode(reader.id);
  }
  await removeSource(source.id);
  renderSources();
  renderCanvas();
  // No status line: the recompile that follows would overwrite it within the
  // debounce anyway, and the rail and canvas both visibly change.
  onGraphChange();
}

/** Vertical gap between Readers when several files are dropped at once. */
const DROPPED_READER_GAP = 110;

/**
 * Put a Reader on the canvas for each dropped file, where it was dropped.
 *
 * Dropping onto the canvas is a statement about where you want the node;
 * dropping onto the rail is just "load this", so only the former makes nodes.
 */
function placeReaders(loaded, at) {
  const world = screenToWorld(at.x, at.y);
  let last = null;
  loaded.forEach((source, index) => {
    const node = addNode("Reader", Math.round(world.x), Math.round(world.y + index * DROPPED_READER_GAP));
    node.params.sourceId = source.id;
    last = node;
  });
  if (!last) return;
  renderCanvas();
  selectNode(last.id);
  onGraphChange();
}

async function loadFiles(files, dropAt = null) {
  const loaded = [];
  for (const file of files) {
    if (!isSupportedFile(file)) {
      setStatus(`${file.name}: only .parquet, .gpkg, .geojson, .json, .fgb, .csv and .xlsx can be opened.`, true);
      continue;
    }
    try {
      setStatus(`Reading ${file.name}…`);
      // A container such as a GeoPackage yields one source per layer.
      const added = await addLocalFile(file, { chooseSheets: pickSheets });
      loaded.push(...added);
      setStatus(
        !added.length
          ? `${file.name}: no sheet opened.`
          : added.length === 1
            ? `${added[0].name}: ${added[0].rows.toLocaleString()} rows.`
            : `${file.name}: ${added.length} layers.`,
      );
    } catch (err) {
      setStatus(`${file.name}: ${err.message}`, true);
    }
  }
  renderSources();
  if (dropAt) placeReaders(loaded, dropAt);
  refreshInspector();
  // A newly available file can be exactly what an invalid Reader was waiting
  // for — including one restored from the autosave before its file was back.
  scheduleRecompile();
}

async function loadUrl(input, { clearInput = true } = {}) {
  if (!input.trim()) return;
  // A Zarr store has no single file to open and no one obvious table inside it,
  // so it goes to the picker instead of straight into the Layers rail.
  if (isZarrPath(input)) {
    if (clearInput) el("url-input").value = "";
    openZarrPicker(input.trim()).catch((err) => setStatus(err.message, true));
    return;
  }
  try {
    setStatus("Reading the remote file…");
    const added = await addRemoteFile(input, { chooseSheets: pickSheets });
    setStatus(
      !added.length
        ? "No sheet opened."
        : added.length === 1
          ? `${added[0].name}: ${added[0].rows.toLocaleString()} rows.`
          : `${added.length} layers loaded.`,
    );
    if (clearInput) el("url-input").value = "";
  } catch (err) {
    setStatus(`Could not read that URL: ${err.message}`, true);
  }
  renderSources();
  refreshInspector();
  // A newly available file can be exactly what an invalid Reader was waiting
  // for — including one restored from the autosave before its file was back.
  scheduleRecompile();
}

/**
 * Flatten a chosen Zarr array into a layer.
 *
 * Everything after the read is the same path a dropped file takes — the rail,
 * the inspector, and a recompile in case an invalid Reader was waiting for
 * exactly this.
 */
async function addZarrSource(choice) {
  setStatus(`Reading ${choice.variable.name}…`);
  const added = await addZarrLayer(choice);
  setStatus(`${added[0].name}: ${added[0].rows.toLocaleString()} rows.`);
  renderSources();
  refreshInspector();
  scheduleRecompile();
}

/* ---------- palette ---------- */

function placeNode(type) {
  const index = graph.nodes.length;
  return addNode(type, 40 + (index % NODES_PER_ROW) * 220, 40 + Math.floor(index / NODES_PER_ROW) * 120);
}

function renderPalette() {
  const palette = el("palette");
  palette.replaceChildren();
  for (const group of PALETTE_GROUPS) {
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group;
    palette.appendChild(label);
    for (const [type, transformer] of Object.entries(TRANSFORMERS)) {
      if (transformer.group !== group) continue;
      const button = document.createElement("button");
      button.textContent = type;
      button.title = transformer.hint || type;
      button.addEventListener("click", () => {
        const node = placeNode(type);
        selectNode(node.id);
        onGraphChange();
      });
      palette.appendChild(button);
    }
  }
}

/* ---------- quick add ---------- */

// Where the pointer last was over the canvas, so a typed transformer lands
// where you are looking rather than at some fixed corner.
let canvasPointer = null;
let quickAddMatches = [];
let quickAddIndex = 0;

function quickAddOpen() {
  return !el("quick-add").hidden;
}

function closeQuickAdd() {
  const panel = el("quick-add");
  panel.hidden = true;
  el("quick-add-input").value = "";
  el("quick-add-list").replaceChildren();
}

function renderQuickAddList() {
  const list = el("quick-add-list");
  list.replaceChildren();
  quickAddMatches.forEach((type, index) => {
    const item = document.createElement("li");
    item.className = index === quickAddIndex ? "selected" : "";
    item.innerHTML = `<span>${type}</span><span class="muted">${TRANSFORMERS[type].group}</span>`;
    // mousedown, not click: the input's blur would otherwise close the panel
    // before a click could land.
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      commitQuickAdd(type);
    });
    list.appendChild(item);
  });
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function refreshQuickAdd() {
  quickAddMatches = searchTransformers(el("quick-add-input").value);
  quickAddIndex = 0;
  renderQuickAddList();
}

function commitQuickAdd(type) {
  if (!type) return;
  const anchor = canvasPointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const world = screenToWorld(anchor.x, anchor.y);
  const node = addNode(type, Math.round(world.x), Math.round(world.y));
  closeQuickAdd();
  selectNode(node.id);
  onGraphChange();
}

function openQuickAdd(seed = "") {
  const panel = el("quick-add");
  const wrap = el("canvas-wrap").getBoundingClientRect();
  const anchor = canvasPointer || { x: wrap.left + wrap.width / 2, y: wrap.top + wrap.height / 3 };
  // Keep the panel inside the canvas, so typing near an edge does not push it
  // out of view.
  const left = Math.min(Math.max(8, anchor.x - wrap.left), wrap.width - 250);
  const top = Math.min(Math.max(8, anchor.y - wrap.top), wrap.height - 60);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.hidden = false;
  const input = el("quick-add-input");
  input.value = seed;
  input.focus();
  refreshQuickAdd();
}

function initQuickAdd() {
  const wrap = el("canvas-wrap");
  wrap.addEventListener("pointermove", (event) => {
    canvasPointer = { x: event.clientX, y: event.clientY };
  });
  wrap.addEventListener("pointerleave", () => {
    canvasPointer = null;
  });
  // Double-clicking empty canvas opens it too.
  el("canvas").addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-node]") || event.target.closest("[data-edge]")) return;
    canvasPointer = { x: event.clientX, y: event.clientY };
    openQuickAdd();
  });

  window.addEventListener("keydown", (event) => {
    const input = el("quick-add-input");
    if (quickAddOpen() && document.activeElement === input) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeQuickAdd();
      } else if (event.key === "Enter") {
        event.preventDefault();
        commitQuickAdd(quickAddMatches[quickAddIndex]);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (quickAddMatches.length) {
          quickAddIndex = (quickAddIndex + step + quickAddMatches.length) % quickAddMatches.length;
          renderQuickAddList();
        }
      }
      return;
    }

    // Start typing over the canvas and the panel appears, carrying the letter
    // that opened it.
    if (!canvasPointer || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    if (!/^[a-zA-Z0-9]$/.test(event.key)) return;
    event.preventDefault();
    openQuickAdd(event.key);
  });

  el("quick-add-input").addEventListener("input", refreshQuickAdd);
  el("quick-add-input").addEventListener("blur", closeQuickAdd);
}

/* ---------- compile and inspect ---------- */

/** Ports the bottom dock can show for a node. */
const keyOf = (nodeId, portId) => `${nodeId}:${portId}`;

/** Split a key back into its parts; the port id may itself be anything. */
function splitKey(key) {
  const cut = key.indexOf(":");
  return { nodeId: key.slice(0, cut), portId: key.slice(cut + 1) };
}

/** Keys that still point at a node that exists and a port it still has. */
function liveKeys() {
  return inspectedKeys.filter((key) => {
    const { nodeId, portId } = splitKey(key);
    const node = nodeById(nodeId);
    return node && inspectablePorts(node).some((port) => port.id === portId);
  });
}

function inspectablePorts(node) {
  if (!node) return [];
  // A Writer produces nothing, so what you want to see is what reaches it.
  if (node.type === "Writer") return [{ id: "input", label: "Input" }];
  return outputPorts(node);
}

function viewFor(node, portId) {
  if (!node) return null;
  if (node.type === "Writer") return upstreamView(node.id, portId, views);
  return views.get(node.id)?.[portId] || null;
}

/** How many coarser steps to offer. Seven of them is a 7^7 reduction, plenty. */
const COARSEN_STEPS = 7;

/**
 * Rebuild the coarsen options for the resolution the current view actually
 * holds, keeping the user's choice if it still applies.
 *
 * Called on every H3 draw, so it must not fight the person using it: silently
 * resetting to full detail each time the graph recompiled would make the
 * control unusable.
 */
function renderCoarsenSelect(dataResolution) {
  const select = el("coarsen-select");
  if (dataResolution === null) {
    select.style.display = "none";
    return;
  }
  const previous = select.value;
  select.style.display = "";
  select.replaceChildren();
  const full = document.createElement("option");
  full.value = "";
  full.textContent = `Full detail (res ${dataResolution})`;
  select.appendChild(full);
  for (let res = dataResolution - 1; res >= Math.max(0, dataResolution - COARSEN_STEPS); res--) {
    const option = document.createElement("option");
    option.value = String(res);
    option.textContent = `res ${res}`;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

/**
 * Which node the bottom panels show.
 *
 * The eye wins when one is pinned; otherwise the panels follow the selection,
 * which is what you want before you have pinned anything. A pin to a node that
 * has since been deleted quietly falls back rather than showing nothing.
 */
function inspectionTarget() {
  const pinned = liveKeys();
  if (pinned.length) return pinned;
  // Nothing pinned: follow the selection, showing its first output.
  const node = nodeById(selected());
  const port = inspectablePorts(node)[0];
  return node && port ? [keyOf(node.id, port.id)] : [];
}

/** The colour each inspected output wears, by its position in the set. */
function inspectionColours() {
  const colours = new Map();
  liveKeys().forEach((key, index) => colours.set(key, inspectColour(index)));
  return colours;
}

/**
 * A label that tells two inspected nodes apart.
 *
 * The type alone is not enough — comparing two Readers is exactly the case
 * multi-inspect exists for, and two tabs both saying "Reader" name nothing.
 * Source nodes carry what they are reading;
 * anything else falls back to its node id, but only when it would otherwise
 * collide.
 */
function nodeLabel(node) {
  if (node.type === "Reader") {
    const source = sources.get(node.params.sourceId);
    if (source) return source.name;
  }
  const sameType = graph.nodes.filter((other) => other.type === node.type);
  return sameType.length > 1 ? `${node.type} ${node.id}` : node.type;
}

/**
 * Rebuild the bottom panels for everything currently inspected.
 *
 * One sheet and one map layer per node, sharing a colour. The map draws them
 * all together; the table shows one sheet at a time, so only the active one is
 * queried.
 */
/**
 * The map's own layer switch: one row per drawn output, click to show or hide.
 *
 * The sheet swatch in the attribute panel already toggled this, but it is a
 * 10px square in the other panel — the control for what the map draws belongs
 * on the map. Both write the same state and the table is told, so the swatch
 * and the legend never disagree.
 */
function renderLegend() {
  const legend = el("map-legend");
  legend.hidden = legendTargets.length === 0;
  legend.replaceChildren();
  for (const target of legendTargets) {
    const row = document.createElement("button");
    row.className = `legend-row${target.visible ? "" : " off"}`;
    row.title = target.visible ? "Hide from the map" : "Show on the map";
    const chip = document.createElement("span");
    chip.className = "legend-chip";
    chip.style.setProperty("--swatch", target.color);
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = target.label;
    row.append(chip, name);
    row.addEventListener("click", () => {
      const visible = !target.visible;
      hiddenLayers = visible
        ? hiddenLayers.filter((key) => key !== target.key)
        : [...new Set([...hiddenLayers, target.key])];
      // Before the local assignment: the sheet and the legend entry are the
      // same object, so setting it here first would make the table's own
      // "already in that state" check skip its re-render.
      setSheetVisible(target.key, visible);
      target.visible = visible;
      renderLegend();
      setHiddenLayers(hiddenLayers).catch((err) => console.warn("Layer visibility", err));
    });
    legend.appendChild(row);
  }
}

/**
 * A label for one inspected output.
 *
 * The port name is only added when the node has more than one output — "Reader"
 * beats "Reader › Output" for the common case, but a Tester's two sheets have
 * to say which is which.
 */
function outputLabel(key) {
  const { nodeId, portId } = splitKey(key);
  const node = nodeById(nodeId);
  if (!node) return key;
  const ports = inspectablePorts(node);
  const port = ports.find((candidate) => candidate.id === portId);
  const base = nodeLabel(node);
  return ports.length > 1 && port ? `${base} › ${port.label}` : base;
}

async function refreshInspection() {
  const seq = ++inspectSeq;
  const keys = inspectionTarget();
  const colours = inspectionColours();

  // Say what the panels are pinned to — a table that does not match the node
  // you just selected otherwise looks like a bug.
  const pin = el("inspect-pin");
  const pinned = liveKeys();
  pin.hidden = pinned.length === 0;
  if (pinned.length === 1) pin.textContent = `\u{1F441} ${outputLabel(pinned[0])}`;
  else if (pinned.length > 1) pin.textContent = `\u{1F441} ${pinned.length} outputs`;

  const targets = [];
  for (const key of keys) {
    const { nodeId, portId } = splitKey(key);
    const node = nodeById(nodeId);
    if (!node) continue;
    const view = viewFor(node, portId);
    if (!view) continue;
    targets.push({
      key,
      nodeId,
      portId,
      label: outputLabel(key),
      view,
      crs: crsByNode.get(nodeId) || LONLAT,
      color: colours.get(key) || inspectColour(0),
      visible: !hiddenLayers.includes(key),
    });
  }

  legendTargets = targets;
  renderLegend();

  if (!targets.length) {
    clearTable(keys.length ? "This node has produced nothing yet." : "Select a node.");
    await showSheets([]);
    clearMap("");
    return;
  }

  try {
    for (const target of targets) target.columns = await describe(target.view);
    if (seq !== inspectSeq) return;
    // The old highlight belonged to whatever was shown before.
    clearPicked();
    await showSheets(targets);
    if (seq !== inspectSeq) return;
    await showGeometries(targets);
  } catch (err) {
    if (seq !== inspectSeq) return;
    clearTable(err.message);
    clearMap("");
  }
}

/**
 * The schema behind each of a node's input ports.
 *
 * Per port, not just "input": a FeatureJoiner's two pickers describe different
 * streams, and offering the left side's columns for the right side's key would
 * be worse than offering none.
 */
async function inputSchemas(node) {
  const byPort = {};
  if (!node || node.type === "Reader") return byPort;
  for (const port of inputPorts(node)) {
    byPort[port.id] = await describeSafely(upstreamView(node.id, port.id, views));
  }
  return byPort;
}

function refreshInspector() {
  const node = nodeById(selected());
  const ports = inspectablePorts(node);
  const upstream = node && node.type !== "Reader" ? viewFor(node, ports[0]?.id) : null;
  // The inspector's column pickers describe the node's INPUT, not its output —
  // you pick which attributes to keep from what arrives, not from what leaves.
  const inputView = node && node.type !== "Reader" ? upstreamView(node.id, "input", views) : null;

  inputSchemas(node).then((columnsByPort) => {
    const firstPort = node ? inputPorts(node)[0]?.id : null;
    renderInspector(el("inspector"), node, {
      columns: columnsByPort[firstPort] || [],
      columnsByPort,
      sources,
      upstreamView: inputView || upstream,
      issues: currentIssues.filter((issue) => issue.nodeId === node?.id),
      crs: node ? crsByNode.get(node.id) || LONLAT : LONLAT,
      // For editors that run their own query against the upstream view.
      settle: graphSettled,
      onHelp: showHelp,
      // A Writer can only write once something reaches it.
      actionReady: Boolean(inputView),
      onAction: (target, action) => {
        if (action === "export") exportWriters([target]);
      },
      commit: (options = {}) => {
        if (options.rerender !== false) refreshInspector();
        // Full change path, not just a recompile: a parameter edit is as much
        // part of the graph as an edge, so it must be saved and undoable too.
        onGraphChange();
      },
    });
  });
}

async function describeSafely(view) {
  if (!view) return [];
  try {
    return await describe(view);
  } catch {
    return [];
  }
}

let currentIssues = [];
// Counting is its own race: a big graph's counts can land after the edit that
// invalidated them, so only the newest run is allowed to reach the canvas.
let countSeq = 0;

/**
 * Count the rows leaving every output port and put them on the canvas.
 *
 * One round trip with a scalar subquery per port rather than a query each: the
 * counts are wanted together, and a Reader on an 823k-row tile makes the
 * per-query overhead worth avoiding. Deliberately not awaited by the caller —
 * counts are informational, and the graph is usable before they arrive.
 */
async function updatePortCounts(views) {
  const seq = ++countSeq;
  const ports = [];
  for (const [nodeId, byPort] of views) {
    for (const [portId, view] of Object.entries(byPort)) ports.push({ nodeId, portId, view });
  }
  if (!ports.length) {
    setPortCounts(new Map());
    return;
  }
  const selection = ports.map((port, index) => `(SELECT count(*) FROM ${port.view}) AS c${index}`);
  try {
    const rows = await query(`SELECT ${selection.join(", ")}`);
    if (seq !== countSeq) return;
    const counts = new Map();
    ports.forEach((port, index) => counts.set(`${port.nodeId}:${port.portId}`, Number(rows[0][`c${index}`])));
    setPortCounts(counts);
  } catch (err) {
    if (seq !== countSeq) return;
    // A count is a nicety; losing it should not look like a broken graph.
    console.warn("Could not count port outputs", err);
    setPortCounts(new Map());
  }
}

async function recompile() {
  currentIssues = validate(sources);
  setIssues(currentIssues);
  const result = await compile(sources);
  views = result.views;
  crsByNode = result.crsByNode;
  // Not awaited: the graph should be usable before the counts land.
  updatePortCounts(views);
  if (result.error) {
    const node = result.error.nodeId ? ` (${result.error.nodeId})` : "";
    setStatus(`${result.error.message}${node}`, true);
  } else if (currentIssues.length) {
    setStatus(currentIssues[0].message, true);
  } else if (graph.nodes.length) {
    setStatus(`${graph.nodes.length} nodes ready.`);
  } else {
    setStatus("Drop a file to start.");
  }
  updateExportButton();
  await refreshInspection();
  refreshInspector();
}

function scheduleRecompile() {
  // Typing an expression fires an input event per keystroke; recompiling on
  // each one would rebuild every downstream view a dozen times a word.
  clearTimeout(recompileTimer);
  recompileTimer = setTimeout(() => {
    // Cleared before running so flushPendingCompile() can tell "an edit is
    // still waiting" from "the graph is current".
    recompileTimer = null;
    track(recompile()).catch((err) => setStatus(err.message, true));
  }, RECOMPILE_DEBOUNCE_MS);
}

/** Remember the running rebuild, so graphSettled() can wait for it. */
function track(promise) {
  // The stored promise is the one `finally` returns, not the one passed in, so
  // the guard has to compare against that — comparing against `promise` never
  // matches, leaves compileInFlight set forever, and turns graphSettled()'s
  // loop into a spin that hangs the page.
  const tracked = promise.finally(() => {
    if (compileInFlight === tracked) compileInFlight = null;
  });
  compileInFlight = tracked;
  return tracked;
}

/**
 * Resolve once the views match the graph — nothing pending, nothing in flight.
 *
 * Anything that reads a compiled view outside the compile itself has to wait
 * for this. A rebuild drops every view before recreating it, so a query run
 * against `n_x_output` mid-rebuild fails with "table does not exist" — which
 * reads as a mistake in the user's SQL rather than as a race.
 */
async function graphSettled() {
  await flushPendingCompile();
  while (compileInFlight) await compileInFlight;
}

function onGraphChange() {
  autosave();
  recordHistory();
  scheduleRecompile();
}

/* ---------- run ---------- */

/** Writers with something connected — the ones that can actually produce a file. */
function connectedWriters() {
  return graph.nodes.filter((node) => node.type === "Writer" && upstreamView(node.id, "input", views));
}

/**
 * Land any edit still sitting in the debounce before writing a file.
 *
 * Not a rebuild for its own sake — the graph is always live. But an export
 * fired within the debounce window of a parameter change would otherwise write
 * the previous version of the data, which is the one bug in this area that
 * would be genuinely hard to notice.
 */
async function flushPendingCompile() {
  if (!recompileTimer) return;
  clearTimeout(recompileTimer);
  recompileTimer = null;
  await track(recompile());
}

async function exportWriters(writers) {
  const button = el("btn-export");
  button.disabled = true;
  try {
    await flushPendingCompile();
    const written = [];
    for (const writer of writers) {
      const view = upstreamView(writer.id, "input", views);
      if (!view) continue;
      setStatus(`Writing ${writer.params.filename || "output"}…`);
      written.push(
        await runWriter(view, writer.params.format || "Parquet", writer.params.filename, {
          crs: upstreamCrs(writer.id, "input", crsByNode),
        }),
      );
    }
    if (!written.length) {
      setStatus("Nothing to write — no Writer is connected.", true);
      return;
    }
    const note = written.find((result) => result.note)?.note;
    setStatus(note || `Wrote ${written.map((result) => result.file).join(", ")}.`, Boolean(note));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    updateExportButton();
  }
}

function updateExportButton() {
  const writers = connectedWriters();
  const button = el("btn-export");
  button.disabled = writers.length === 0;
  button.title = writers.length
    ? `Write ${writers.length === 1 ? "1 file" : `${writers.length} files`}`
    : "Connect a Writer node to export";
}

/* ---------- undo / redo ---------- */

const HISTORY_LIMIT = 60;
// Long enough that typing an expression is one undo step, short enough that it
// has landed before you reach for the button.
const HISTORY_DEBOUNCE_MS = 450;

let past = [];
let future = [];
let committed = null;
let historyTimer = null;

function snapshot() {
  return JSON.stringify(serialize());
}

function updateHistoryButtons() {
  el("btn-undo").disabled = past.length === 0;
  el("btn-redo").disabled = future.length === 0;
}

/**
 * Record the graph as it now stands.
 *
 * Debounced, so a typed expression collapses into one step rather than one per
 * keystroke; structural edits arrive singly and get their own step anyway.
 */
function recordHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    const current = snapshot();
    if (current === committed) return;
    if (committed !== null) past.push(committed);
    if (past.length > HISTORY_LIMIT) past.shift();
    committed = current;
    future = [];
    updateHistoryButtons();
  }, HISTORY_DEBOUNCE_MS);
}

function applySnapshot(json) {
  loadGraph(JSON.parse(json));
  committed = json;
  renderCanvas();
  selectNode(null);
  autosave();
  updateHistoryButtons();
  scheduleRecompile();
}

function undo() {
  // Land anything still in the debounce first, or the step about to be undone
  // is not yet the one on the stack.
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
    const current = snapshot();
    if (current !== committed) {
      if (committed !== null) past.push(committed);
      committed = current;
      future = [];
    }
  }
  if (!past.length) return;
  future.push(committed);
  applySnapshot(past.pop());
}

function redo() {
  if (!future.length) return;
  past.push(committed);
  applySnapshot(future.pop());
}

function initHistory() {
  el("btn-undo").addEventListener("click", undo);
  el("btn-redo").addEventListener("click", redo);
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    // Inside a text field, leave undo to the browser — it is editing the text,
    // not the graph.
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === "y") {
      event.preventDefault();
      redo();
    }
  });
}

/* ---------- persistence ---------- */

function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serialize()));
  } catch (err) {
    console.warn("Could not autosave the graph", err);
  }
}

function restoreAutosave() {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return;
    loadGraph(JSON.parse(saved));
    renderCanvas();
  } catch (err) {
    console.warn("Could not restore the saved graph", err);
  }
}

function exportGraph() {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "graph.flow.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importGraph(file) {
  try {
    loadGraph(JSON.parse(await file.text()));
    renderCanvas();
    selectNode(null);
    onGraphChange();
    setStatus(`Opened ${file.name}. Load the files its Readers need.`);
  } catch (err) {
    setStatus(`Could not open that graph: ${err.message}`, true);
  }
}

/* ---------- help modal ---------- */

/** A transformer's long explanation, out of the panel and into a modal. */
function showHelp(help) {
  el("help-title").textContent = help.title || "About";
  const body = el("help-body");
  body.replaceChildren();
  for (const paragraph of help.intro || []) {
    body.appendChild(Object.assign(document.createElement("p"), { textContent: paragraph }));
  }
  if (help.code) {
    body.appendChild(
      Object.assign(document.createElement("pre"), { className: "syntax-text", textContent: help.code }),
    );
  }
  el("help-modal").hidden = false;
}

/* ---------- feature geometry modal ---------- */

/**
 * What one feature's geometry is, from the table's per-row button.
 *
 * The CRS comes from the sheet on screen rather than from the picked row: the
 * row carries coordinates and nothing that says what they mean, and after a
 * Reprojector that difference is the whole point.
 */
async function showGeometryInfo(pick) {
  const body = el("geometry-body");
  body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Reading…" }));
  el("geometry-modal").hidden = false;
  try {
    renderFeature(body, await describeFeature(pick, currentSheet()?.crs || LONLAT));
  } catch (err) {
    body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: err.message }));
  }
}

function initGeometryModal() {
  const modal = el("geometry-modal");
  el("geometry-close").addEventListener("click", () => (modal.hidden = true));
  // The backdrop closes; the panel must not.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

function initHelpModal() {
  const modal = el("help-modal");
  el("help-close").addEventListener("click", () => (modal.hidden = true));
  // The backdrop closes; the panel must not.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

/* ---------- dock resizing ---------- */

/** Keep in step with the 6px splitter column in #dock. */
const SPLITTER_WIDTH = 6;

function initDockResizer() {
  const resizer = el("dock-resizer");
  const shell = el("shell");
  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const move = (moveEvent) => {
      const height = Math.min(Math.max(120, window.innerHeight - moveEvent.clientY), window.innerHeight - 220);
      shell.style.setProperty("--dock-height", `${height}px`);
      resizeMap();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });
}

/** The table/map split. Sets the table's width; the map absorbs the remainder. */
function initDockSplitter() {
  const splitter = el("dock-splitter");
  const dock = el("dock");
  const MIN_PANE = 220;

  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    document.body.classList.add("splitting");
    const left = dock.getBoundingClientRect().left;
    const move = (moveEvent) => {
      const available = dock.clientWidth - SPLITTER_WIDTH;
      const width = Math.min(Math.max(MIN_PANE, moveEvent.clientX - left), available - MIN_PANE);
      dock.style.setProperty("--table-width", `${Math.round(width)}px`);
      resizeMap();
    };
    const stop = () => {
      document.body.classList.remove("splitting");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });

  // Back to an even split: dropping the property restores the 1fr default.
  splitter.addEventListener("dblclick", () => {
    dock.style.removeProperty("--table-width");
    resizeMap();
  });
}

/* ---------- drag and drop ---------- */

function initDropZone() {
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("dragover", (event) => {
    stop(event);
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget) return;
    document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (event) => {
    stop(event);
    document.body.classList.remove("dragging");
    const onCanvas = Boolean(event.target?.closest?.("#canvas-wrap"));
    loadFiles([...event.dataTransfer.files], onCanvas ? { x: event.clientX, y: event.clientY } : null);
  });
  el("dropzone").addEventListener("click", () => el("file-input").click());
  el("file-input").addEventListener("change", (event) => loadFiles([...event.target.files]));
}

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

async function main() {
  await openSession();
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
      hiddenLayers = allSheets.filter((sheet) => sheet.visible === false).map((sheet) => sheet.key);
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
        inspectedKeys = inspectedKeys.includes(key)
          ? inspectedKeys.filter((other) => other !== key)
          : [...inspectedKeys, key];
      } else {
        // Plain click: this output alone, or unpin if it already was the only one.
        const only = inspectedKeys.length === 1 && inspectedKeys[0] === key;
        inspectedKeys = only ? [] : [key];
      }
      setInspected(inspectionColours());
      refreshInspection().catch((err) => setStatus(err.message, true));
    },
    onChange: onGraphChange,
    onLayoutChange: autosave,
  });
  renderPalette();
  renderSources();
  initDropZone();
  initDockResizer();
  initDockSplitter();
  initHelpModal();
  initGeometryModal();
  initQuickAdd();
  initHistory();
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
    inspectedKeys = [];
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
  restoreAutosave();
  // The restored graph is the baseline; undo should not walk back past it into
  // an empty canvas the user never saw.
  committed = snapshot();
  updateHistoryButtons();
  await recompile();
  setStatus(graph.nodes.length ? "Restored your last graph." : "Drop a file to start.");
}

main().catch((err) => setStatus(`Startup failed: ${err.message}`, true));

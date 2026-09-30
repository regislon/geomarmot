/*
 * Inspection: which outputs the bottom panels show, their colours, the map
 * legend, and the inspector for the selected node.
 */

import { graph, inputPorts, nodeById, outputPorts, upstreamView } from "../core/graph/index.js";
import { LONLAT, describe } from "../core/schema.js";
import { sources } from "../io/sources.js";
import { selected } from "./canvas/index.js";
import { renderInspector } from "./inspector/index.js";
import { clearMap, clearPicked, setHiddenLayers, showGeometries } from "./map/index.js";
import { inspectColour } from "./palette.js";
import { clearTable, setSheetVisible, showSheets } from "./table.js";
import { crsByNode, currentIssues, graphSettled, nodeStates, onGraphChange, views } from "./compile-loop.js";
import { el } from "./dom.js";
import { exportWriters } from "./export.js";
import { showHelp } from "./modals.js";

// nodeId -> the output port its sheet shows. Remembered per node so switching
// between sheets does not reset a Tester back to its "passed" port.
/*
 * What the bottom panels are pinned to: "nodeId:portId" keys, one per inspected
 * output. Keyed by port rather than by node because a Tester has two things
 * leaving it and both are worth seeing at once.
 */
// Inspected nodes whose features are hidden on the map; the sheet still shows
// its rows. Survives a rebuild so a hidden layer stays hidden.
export let hiddenLayers = [];
/** The outputs the map is drawing — the legend and the sheet tabs share these. */
export let legendTargets = [];
// Nodes the eye is pinned to, in the order they were added — that order is what
// assigns their colours. Empty means the panels follow the selection.
export let inspectedKeys = [];
// Monotonic ticket for inspection queries. Clicking through nodes faster than
// DuckDB answers is normal; without this the slowest reply wins the panel.
let inspectSeq = 0;
/* ---------- compile and inspect ---------- */

/** Ports the bottom dock can show for a node. */
const keyOf = (nodeId, portId) => `${nodeId}:${portId}`;

/** Split a key back into its parts; the port id may itself be anything. */
export function splitKey(key) {
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
export function renderCoarsenSelect(dataResolution) {
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
export function inspectionColours() {
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
export function renderLegend() {
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

export async function refreshInspection() {
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
    // A node that failed or sits below a failure shows why, never an older result.
    const state = keys.map((key) => nodeStates.get(splitKey(key).nodeId)).find((s) => s && s.status !== "ok");
    clearTable(state ? state.message : keys.length ? "This node has produced nothing yet." : "Select a node.");
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

export function refreshInspector() {
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

/** Replace the pinned outputs (the eyes on the canvas). */
export function setInspectedKeys(keys) {
  inspectedKeys = keys;
}

/** Replace the set of inspected outputs hidden on the map. */
export function setHiddenLayerKeys(keys) {
  hiddenLayers = keys;
}

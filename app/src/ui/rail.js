/*
 * The left rail: the loaded sources (Layers) and the transformer palette.
 */

import { PALETTE_GROUPS, REGISTRY } from "../../../transformers/index.js";
import { addNode, graph, removeNode } from "../core/graph/index.js";
import { isLonLat } from "../core/schema.js";
import { addLocalFile, addRemoteFile, addZarrLayer, isSupportedFile, removeSource, sources } from "../io/sources.js";
import { isZarrPath } from "../io/zarr/index.js";
import { render as renderCanvas, screenToWorld, select as selectNode, selected, setInspected } from "./canvas/index.js";
import { pickSheets } from "./sheetpicker.js";
import { openZarrPicker } from "./zarrpicker.js";
import { onGraphChange, scheduleRecompile } from "./compile-loop.js";
import { el, setStatus } from "./dom.js";
import { inspectedKeys, inspectionColours, refreshInspector, setInspectedKeys, splitKey } from "./inspect.js";
import { withProgress } from "./progress.js";

const NODES_PER_ROW = 4;

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

export function renderSources() {
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
      setInspectedKeys(inspectedKeys.filter((key) => !pinnedHere.includes(key)));
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

export async function loadFiles(files, dropAt = null) {
  const loaded = [];
  for (const file of files) {
    if (!isSupportedFile(file)) {
      setStatus(`${file.name}: only .parquet, .gpkg, .geojson, .json, .fgb, .csv and .xlsx can be opened.`, true);
      continue;
    }
    try {
      setStatus(`Reading ${file.name}…`);
      // A container such as a GeoPackage yields one source per layer.
      const added = await withProgress(`Opening ${file.name}…`, () => addLocalFile(file, { chooseSheets: pickSheets }));
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

export async function loadUrl(input, { clearInput = true } = {}) {
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
    const name = decodeURIComponent(input.trim().split("/").pop() || "the remote file");
    const added = await withProgress(`Opening ${name}…`, () => addRemoteFile(input, { chooseSheets: pickSheets }));
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
export async function addZarrSource(choice) {
  setStatus(`Reading ${choice.variable.name}…`);
  const added = await withProgress(`Reading ${choice.variable.name}…`, () => addZarrLayer(choice));
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

export function renderPalette() {
  const palette = el("palette");
  palette.replaceChildren();
  for (const group of PALETTE_GROUPS) {
    const members = [...REGISTRY].filter(([, transformer]) => transformer.group === group);
    if (!members.length) continue;
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group;
    palette.appendChild(label);
    for (const [type, transformer] of members) {
      const button = document.createElement("button");
      button.textContent = type;
      button.title = transformer.hint || type;
      if (transformer.generated) {
        button.classList.add("generated");
        button.title = `Generated by the assistant. ${button.title}`;
      }
      button.addEventListener("click", () => {
        const node = placeNode(type);
        selectNode(node.id);
        onGraphChange();
      });
      palette.appendChild(button);
    }
  }
}

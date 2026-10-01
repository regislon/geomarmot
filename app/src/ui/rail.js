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

/**
 * What a layer's line says on hover: its size, geometry or H3 index, CRS and
 * where it came from — and the one thing worth a mark on the line itself, a
 * CRS that was assumed rather than declared.
 */
function sourceFacts(source) {
  const facts = [`${source.rows.toLocaleString()} rows · ${source.columns.length} columns`];
  let warn = null;
  if (source.geometry) facts.push("geometry");
  else if (source.h3?.mode === "none") warn = source.h3.note;
  else if (source.h3?.mode === "column")
    facts.push(`H3 index from the "${source.h3.column}" column, parent ${source.h3.parent}`);
  else if (source.h3) facts.push(`H3 res ${source.h3.resolution} from row order, parent ${source.h3.parent}`);
  const crs = source.crs;
  if ((source.geometry || (source.h3 && source.h3.mode !== "none")) && crs) {
    const code = crs.display || crs.code;
    if (crs.assumed)
      warn = "The file declares no CRS, so it is taken as lon/lat. Set a CRS override on the Reader if that is wrong.";
    // Any Reader on this source reprojects it; `display` is set when the code is a whole WKT.
    else facts.push(isLonLat(crs) ? code : `${code}, reprojected to lon/lat when read`);
  }
  facts.push(source.origin);
  return { title: [source.name, ...facts, ...(warn ? [warn] : [])].join("\n"), warn };
}

/** One line per layer: kind, name, rows, + Reader and remove. */
export function renderSources() {
  const list = el("source-list");
  list.replaceChildren();
  if (!sources.size) return;
  for (const source of sources.values()) {
    const { title, warn } = sourceFacts(source);
    const line = document.createElement("div");
    line.className = "source";
    line.title = title;
    const kind = source.geometry ? "◆" : source.h3 ? "⬡" : "▤";
    line.innerHTML =
      `<span class="source-kind">${kind}</span><span class="source-name"></span>` +
      (warn ? `<span class="badge warn">?</span>` : "") +
      `<span class="source-rows">${source.rows.toLocaleString()}</span>`;
    line.querySelector(".source-name").textContent = source.name;

    const button = document.createElement("button");
    button.className = "source-add";
    button.textContent = "+ Reader";
    button.title = "Add a Reader for this layer";
    button.addEventListener("click", () => {
      const node = placeNode("Reader");
      node.params.sourceId = source.id;
      selectNode(node.id);
      onGraphChange();
    });

    const remove = document.createElement("button");
    remove.className = "icon-btn source-remove";
    remove.textContent = "×";
    // Not a live count: the rail is only re-rendered when sources change, so a
    // number baked in here would be wrong the moment a Reader is added.
    remove.title = "Remove this layer and any Readers using it";
    remove.addEventListener("click", () => {
      removeLayer(source).catch((err) => setStatus(err.message, true));
    });
    line.append(button, remove);
    list.appendChild(line);
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

export async function loadUrl(input) {
  if (!input.trim()) return;
  // A Zarr store has no single file to open and no one obvious table inside it,
  // so it goes to the picker instead of straight into the Layers rail.
  if (isZarrPath(input)) {
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

/*
 * Quick Add: type over the canvas to drop a transformer where the pointer is.
 */

import { TRANSFORMERS, searchTransformers } from "../../../transformers/legacy.js";
import { addNode } from "../core/graph.js";
import { screenToWorld, select as selectNode } from "./canvas/index.js";
import { onGraphChange } from "./compile-loop.js";
import { el } from "./dom.js";

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

export function initQuickAdd() {
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

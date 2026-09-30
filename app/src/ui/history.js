/* Undo and redo, as debounced snapshots of the graph. */

import { load as loadGraph, serialize } from "../core/graph/index.js";
import { render as renderCanvas, select as selectNode } from "./canvas/index.js";
import { scheduleRecompile } from "./compile-loop.js";
import { el } from "./dom.js";
import { autosave } from "./persistence.js";

/* ---------- undo / redo ---------- */

const HISTORY_LIMIT = 60;
// Long enough that typing an expression is one undo step, short enough that it
// has landed before you reach for the button.
const HISTORY_DEBOUNCE_MS = 450;

let past = [];
let future = [];
export let committed = null;
let historyTimer = null;

export function snapshot() {
  return JSON.stringify(serialize());
}

export function updateHistoryButtons() {
  el("btn-undo").disabled = past.length === 0;
  el("btn-redo").disabled = future.length === 0;
}

/**
 * Record the graph as it now stands.
 *
 * Debounced, so a typed expression collapses into one step rather than one per
 * keystroke; structural edits arrive singly and get their own step anyway.
 */
export function recordHistory() {
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
  loadGraph(JSON.parse(json), { trusted: true });
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

export function initHistory() {
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

/** Take the current graph as the baseline the next edit is measured against. */
export function resetHistoryBaseline() {
  committed = snapshot();
}

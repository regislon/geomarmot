/*
 * The compile loop: debounced recompiles, port counts, and the promise that
 * says when the graph has settled.
 */

import { query } from "../core/duck.js";
import { graph, mainCompiler, validate } from "../core/graph/index.js";
import { sources } from "../io/sources.js";
import { setIssues, setPortCounts } from "./canvas/index.js";
import { setStatus } from "./dom.js";
import { updateExportButton } from "./export.js";
import { recordHistory } from "./history.js";
import { refreshInspection, refreshInspector } from "./inspect.js";
import { autosave } from "./persistence.js";
import { setReadGuard } from "./read-guard.js";

const RECOMPILE_DEBOUNCE_MS = 220;
// The generation the UI is showing, held by a lease so its views stay valid
// until the UI has moved on to a newer one.
let uiLease = mainCompiler.acquire();
export let views = uiLease.views;
// Which coordinate system each node's output is in, so the map can bring a
// reprojected stream home for drawing and a Writer knows what it is holding.
export let crsByNode = uiLease.crsByNode;
// nodeId -> { status: "ok" | "error" | "blocked", message } for the shown generation.
export let nodeStates = uiLease.states;
/** A lease on the generation the UI is showing, for a read that must finish against it. */
export function retainShown() {
  return uiLease.retain();
}
setReadGuard(() => {
  const lease = uiLease.retain();
  return () => lease.release();
});
export let recompileTimer = null;
let compileInFlight = null;

export let currentIssues = [];
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
async function updatePortCounts(lease) {
  const seq = ++countSeq;
  const views = lease.views;
  const ports = [];
  for (const [nodeId, byPort] of views) {
    for (const [portId, view] of Object.entries(byPort)) ports.push({ nodeId, portId, view });
  }
  const selection = ports.map((port, index) => `(SELECT count(*) FROM ${port.view}) AS c${index}`);
  try {
    // Inside the try, so the lease is released on this path too — a leaked
    // lease would keep its generation alive and block every later compile.
    if (!ports.length) {
      setPortCounts(new Map());
      return;
    }
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
  } finally {
    lease.release();
  }
}

export async function recompile() {
  currentIssues = validate(sources);
  setIssues(currentIssues);
  const result = await mainCompiler.compile();
  const next = mainCompiler.acquire();
  if (next.gen <= uiLease.gen) {
    // Another recompile already moved the UI to this generation or a newer one.
    next.release();
    return;
  }
  const previous = uiLease;
  uiLease = next;
  views = next.views;
  crsByNode = next.crsByNode;
  nodeStates = next.states;
  // Not awaited: the graph should be usable before the counts land.
  updatePortCounts(next.retain());
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
  try {
    await refreshInspection();
    refreshInspector();
  } finally {
    // Only now is nothing on screen reading the previous generation.
    previous.release();
  }
}

export function scheduleRecompile() {
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
export function track(promise) {
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

/** Resolve once the views match the graph — nothing pending, nothing in flight. */
export async function graphSettled() {
  await flushPendingCompile();
  while (compileInFlight) await compileInFlight;
}

export function onGraphChange() {
  autosave();
  recordHistory();
  scheduleRecompile();
}

/**
 * Land any edit still sitting in the debounce before writing a file.
 *
 * Not a rebuild for its own sake — the graph is always live. But an export
 * fired within the debounce window of a parameter change would otherwise write
 * the previous version of the data, which is the one bug in this area that
 * would be genuinely hard to notice.
 */
export async function flushPendingCompile() {
  if (!recompileTimer) return;
  clearTimeout(recompileTimer);
  recompileTimer = null;
  await track(recompile());
}

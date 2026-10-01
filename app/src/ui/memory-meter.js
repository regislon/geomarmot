/*
 * The memory meter in the toolbar: what the engine holds against its limit.
 *
 * DuckDB reports its own buffer memory (duckdb_memory()), which is what the
 * limit applies to and what runs out first on a large file. The files you
 * opened are held by the browser outside that limit; the tooltip counts them
 * too. Polled every few seconds while the tab is visible, one query at a time,
 * so a long-running query only delays the meter.
 */

import { query } from "../core/duck.js";
import { memoryLimit } from "../core/memory.js";
import { sources } from "../io/sources.js";

const EVERY_MS = 2500;
const GB = 1024 ** 3;

let elements = null;
let busy = false;

const gb = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

async function sample(always = false) {
  if (busy || (document.hidden && !always)) return;
  busy = true;
  try {
    const [row] = await query("SELECT sum(memory_usage_bytes) AS used FROM duckdb_memory()");
    const used = Number(row?.used ?? 0);
    const limit = parseFloat(memoryLimit()) * GB;
    const share = Math.min(1, used / limit);
    const percent = Math.round(share * 100);
    elements.fill.style.width = `${Math.max(2, percent)}%`;
    elements.root.dataset.level = share >= 0.85 ? "high" : share >= 0.6 ? "mid" : "low";
    elements.text.textContent = `${gb(used)} / ${gb(limit)}`;
    elements.root.setAttribute("aria-valuenow", String(percent));
    const files = [...new Map([...sources.values()].map((s) => [s.fileName, s.sizeBytes || 0])).values()];
    const held = files.reduce((sum, size) => sum + size, 0);
    elements.root.title =
      `The engine uses ${gb(used)} of its ${gb(limit)} limit (${percent}%). ` +
      (held ? `The files you opened take another ${gb(held)}, held by the browser. ` : "") +
      "Sorting, grouping, deduplicating and joining large data use the most; past the limit a step fails with an out-of-memory error.";
    elements.root.hidden = false;
  } catch {
    // Restarting or busy beyond the read timeout: the next sample will tell.
  } finally {
    busy = false;
  }
}

export function initMemoryMeter() {
  elements = {
    root: document.getElementById("memory"),
    fill: document.getElementById("memory-fill"),
    text: document.getElementById("memory-text"),
  };
  sample(true);
  setInterval(sample, EVERY_MS);
  document.addEventListener("visibilitychange", sample);
}

/*
 * The progress card in the middle of the canvas.
 *
 * Everything that takes a moment says so here: starting the engine, opening a
 * file, running the graph and its slow steps (H3 cells, JSTS shapes, Zarr
 * chunks), writing files. Each is a task — `beginTask(label)` returns a handle
 * to `update()` and `end()` — and the card shows the newest task still
 * running, so an export started during a compile is not hidden by it. A known
 * fraction fills the bar; without one the bar sweeps, still visibly alive.
 *
 * A task is only shown once it has lasted a quarter of a second, so the many
 * compiles that finish in a few milliseconds never flash a card. The card
 * does not block the canvas: editing goes on, and the newest edit wins.
 */

const SHOW_AFTER_MS = 250;

let elements = null;
const tasks = [];
let seq = 0;

export function initProgress(config) {
  elements = config;
  render();
}

function render() {
  if (!elements) return;
  const now = performance.now();
  const shown = [...tasks].reverse().find((task) => now - task.started >= task.delay);
  if (!shown) {
    elements.root.hidden = true;
    elements.fill.style.width = "0%";
    return;
  }
  elements.root.hidden = false;
  elements.label.textContent = shown.label;
  const known = typeof shown.fraction === "number" && Number.isFinite(shown.fraction);
  elements.root.classList.toggle("indeterminate", !known);
  elements.root.setAttribute("aria-valuetext", shown.label);
  if (known) {
    const percent = Math.round(Math.min(1, Math.max(0, shown.fraction)) * 100);
    elements.fill.style.width = `${percent}%`;
    elements.root.setAttribute("aria-valuenow", String(percent));
    if (elements.percent) elements.percent.textContent = `${percent}%`;
  } else {
    elements.fill.style.width = "";
    elements.root.removeAttribute("aria-valuenow");
    if (elements.percent) elements.percent.textContent = "";
  }
}

/** "Building hexagons… 25,000 of 60,000" carries its own fraction. */
function fractionIn(label) {
  const match = String(label).match(/([\d,.\s]+)\s+of\s+([\d,.\s]+)/);
  if (!match) return null;
  const done = Number(match[1].replace(/[^\d]/g, ""));
  const total = Number(match[2].replace(/[^\d]/g, ""));
  return total > 0 ? done / total : null;
}

/**
 * Start a task.
 * @param {string} label
 * @param {{ fraction?: number|null, delay?: number }} [options]  `delay`: how long before it shows (ms)
 */
export function beginTask(label, { fraction = null, delay = SHOW_AFTER_MS } = {}) {
  const task = { id: ++seq, label, fraction, delay, started: performance.now(), ended: false };
  tasks.push(task);
  if (delay > 0) setTimeout(render, delay + 5);
  render();
  return {
    /** Change the label, and the fraction (null: unknown; undefined: read it from the label). */
    update(nextLabel, nextFraction) {
      if (task.ended) return;
      if (nextLabel) task.label = nextLabel;
      task.fraction = nextFraction === undefined ? fractionIn(task.label) : nextFraction;
      render();
    },
    end() {
      if (task.ended) return;
      task.ended = true;
      tasks.splice(tasks.indexOf(task), 1);
      render();
    },
  };
}

/** Run `work` as a task; the card goes when it settles, whichever way. */
export async function withProgress(label, work, options) {
  const task = beginTask(label, options);
  try {
    return await work(task);
  } finally {
    task.end();
  }
}

/*
 * The engines report progress as messages ("Filling polygons… 12,000 cells").
 * They land in the newest task, or in a task of their own when nothing else is
 * running; null ends that one.
 */
let reported = null; // { handle, id } of the task the engines' messages opened themselves
const alive = (id) => tasks.some((task) => task.id === id);

export function reportProgress(message) {
  if (message === null || message === undefined || message === "") {
    reported?.handle.end();
    reported = null;
    return;
  }
  const top = tasks.at(-1);
  if (top && top.id !== reported?.id) {
    top.label = message;
    top.fraction = fractionIn(message);
    render();
    return;
  }
  if (reported && alive(reported.id)) reported.handle.update(message);
  else reported = { handle: beginTask(message, { fraction: fractionIn(message) }), id: seq };
}

/* The older single-bar calls, used by the Excel reader and writer and by downloads. */
let single = null;

/** Show `label`, with `fraction` in [0, 1] or null for "working, no estimate". */
export function showProgress(label, fraction = null) {
  if (!single) single = beginTask(label, { fraction, delay: 0 });
  else single.update(label, fraction);
}

export function hideProgress() {
  single?.end();
  single = null;
}

/**
 * Read a response body with the bar following the download.
 *
 * `fetch().arrayBuffer()` says nothing until the last byte lands, which for a
 * 50 MB workbook through the GCS proxy is a long silence. Reading the stream
 * gives a fraction whenever the server sent a Content-Length.
 */
export async function readWithProgress(response, label) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    const megabytes = (received / 1e6).toFixed(1);
    showProgress(
      total ? `${label} — ${megabytes} of ${(total / 1e6).toFixed(1)} MB` : `${label} — ${megabytes} MB`,
      total ? received / total : null,
    );
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

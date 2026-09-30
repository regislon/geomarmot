/*
 * The Zarr picker.
 *
 * A parquet needs no dialogue: the file is the layer. A Zarr store is a folder
 * of arrays with any number of dimensions, and turning one into a table means
 * making three decisions nothing in the path can make for you — which array,
 * where the non-spatial dimensions are pinned, and how much of the grid to
 * bring back. So there is a modal, and it shows the cost of the plan before the
 * plan runs.
 *
 * The cost line is the point of the whole panel. Sampling coarsely reads
 * exactly the same chunks as sampling finely — the chunk is the unit of
 * transfer — so "rows" and "MB to read" move independently, and someone who
 * only sees a row count will happily ask for 2 GB by accident.
 */

import { resolveUrl } from "./sources.js";
import {
  DEFAULT_CELL_BUDGET,
  defaultPlan,
  openZarrStore,
  planRefusal,
  planStats,
  resolveGeoreference,
} from "./zarr.js";

/** Cell budgets offered, against the map's own 8k-250k drawing limits. */
const BUDGETS = [25_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000];

/** Above this many positions a dimension gets a number box instead of a list. */
const SELECT_LIMIT = 200;

let elements = {};
let onAdd = null;
let state = { store: null, variable: null, georeference: null, plan: null, busy: false };

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function setNote(message, isError = false) {
  elements.note.textContent = message || "";
  elements.note.classList.toggle("error", Boolean(isError));
}

/* ---------- the array list ---------- */

function renderVariables() {
  const list = elements.variables;
  list.replaceChildren();
  for (const variable of state.store.variables) {
    const item = document.createElement("button");
    item.className = "zarr-var";
    if (variable === state.variable) item.classList.add("selected");
    item.disabled = !variable.readable;
    const shape = variable.shape.map((length, axis) => `${variable.dims[axis]}=${length.toLocaleString()}`);
    item.innerHTML = `<span class="zarr-var-name"></span><span class="zarr-var-meta"></span>`;
    item.querySelector(".zarr-var-name").textContent = variable.name;
    item.querySelector(".zarr-var-meta").textContent = variable.readable
      ? `${variable.dtype} · ${shape.join(" × ")}`
      : `${variable.dtype} · not readable as a table`;
    if (variable.readable) item.addEventListener("click", () => selectVariable(variable));
    list.appendChild(item);
  }
}

async function selectVariable(variable) {
  state.variable = variable;
  state.georeference = null;
  renderVariables();
  elements.plan.replaceChildren();
  setNote("Reading the coordinates…");
  try {
    state.georeference = await resolveGeoreference(state.store, variable);
  } catch (err) {
    setNote(`Could not read this array's coordinates: ${err.message}`, true);
    return;
  }
  state.plan = defaultPlan(variable, DEFAULT_CELL_BUDGET);
  setNote("");
  renderPlan();
}

/* ---------- the plan panel ---------- */

function field(label, control, hint) {
  const wrap = document.createElement("label");
  wrap.className = "zarr-field";
  const text = document.createElement("span");
  text.className = "zarr-field-label";
  text.textContent = label;
  wrap.append(text, control);
  if (hint) {
    const note = document.createElement("span");
    note.className = "zarr-field-hint";
    note.textContent = hint;
    wrap.appendChild(note);
  }
  return wrap;
}

function numberBox(value, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.min = "0";
  input.addEventListener("change", () => onChange(Number(input.value)));
  return input;
}

/** A pin control for one dimension: a list of its coordinate values, or a box. */
function pinControl(dim, length) {
  const labels = state.georeference.labels[dim];
  const current = state.plan.pins[dim] ?? 0;
  if (length <= SELECT_LIMIT) {
    const select = document.createElement("select");
    for (let index = 0; index < length; index++) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = labels ? String(labels[index]) : `#${index}`;
      option.selected = index === current;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      state.plan.pins[dim] = Number(select.value);
      renderPlan();
    });
    return { control: select, hint: labels ? "" : "no coordinate array — positions only" };
  }
  return {
    control: numberBox(current, (value) => {
      state.plan.pins[dim] = Math.min(Math.max(0, value), length - 1);
      renderPlan();
    }),
    hint: labels ? `= ${labels[current]}` : `0 – ${(length - 1).toLocaleString()}`,
  };
}

/** What the geo-reference amounts to, said plainly. */
function georeferenceSummary() {
  const { kind, crs, affine, rotated } = state.georeference;
  if (kind === "none") {
    return "No geo-reference found: the layer gets array indexes and no geometry.";
  }
  const where = kind === "affine" ? `affine from \`${affine.source}\`` : "coordinate arrays";
  const cell =
    kind === "affine"
      ? `${Math.abs(affine.a)} × ${Math.abs(affine.e)} cells`
      : "cell size from the coordinate spacing";
  const crsText = crs ? crs.code : "no CRS declared — taken as lon/lat";
  return `${crsText} · ${cell} · ${where}${rotated ? " · rotated grid, footprints unavailable" : ""}`;
}

function renderPlan() {
  const panel = elements.plan;
  const variable = state.variable;
  const plan = state.plan;
  panel.replaceChildren();

  const summary = document.createElement("p");
  summary.className = "zarr-summary";
  summary.textContent = georeferenceSummary();
  panel.appendChild(summary);

  if (plan.narrowed) {
    const narrowed = document.createElement("p");
    narrowed.className = "zarr-summary warn";
    narrowed.textContent =
      "This array is too big to read whole, so the window opens on a patch in the middle of it. " +
      "Move it, or widen it until the cost line says no.";
    panel.appendChild(narrowed);
  }

  if (!variable.axesNamed) {
    const guessed = document.createElement("p");
    guessed.className = "zarr-summary warn";
    guessed.textContent =
      `This array does not name its dimensions, so the last two — ` +
      `${variable.dims[variable.yAxis]} and ${variable.dims[variable.xAxis]} — are taken as the grid.`;
    panel.appendChild(guessed);
  }

  if (variable.scaleFactor !== 1 || variable.addOffset !== 0) {
    const scaled = document.createElement("p");
    scaled.className = "zarr-summary";
    scaled.textContent = `Values decoded with scale_factor=${variable.scaleFactor}, add_offset=${variable.addOffset}.`;
    panel.appendChild(scaled);
  }

  for (const [axis, dim] of variable.dims.entries()) {
    if (axis === variable.yAxis || axis === variable.xAxis) continue;
    const { control, hint } = pinControl(dim, variable.shape[axis]);
    panel.appendChild(field(dim, control, hint));
  }

  const windowRow = document.createElement("div");
  windowRow.className = "zarr-window";
  for (const key of ["y", "x"]) {
    const axis = key === "y" ? variable.yAxis : variable.xAxis;
    const pair = document.createElement("div");
    pair.className = "zarr-pair";
    const from = numberBox(plan.window[key][0], (value) => {
      plan.window[key][0] = Math.min(Math.max(0, value), variable.shape[axis] - 1);
      retune();
    });
    const to = numberBox(plan.window[key][1], (value) => {
      plan.window[key][1] = Math.min(Math.max(1, value), variable.shape[axis]);
      retune();
    });
    pair.append(from, document.createTextNode("→"), to);
    windowRow.appendChild(
      field(`${variable.dims[axis]} range`, pair, `0 – ${variable.shape[axis].toLocaleString()}`),
    );
  }
  panel.appendChild(windowRow);

  const full = document.createElement("button");
  full.className = "wide-btn";
  full.textContent = "Whole extent";
  full.addEventListener("click", () => {
    plan.window.y = [0, variable.shape[variable.yAxis]];
    plan.window.x = [0, variable.shape[variable.xAxis]];
    retune();
  });
  panel.appendChild(full);

  const budget = document.createElement("select");
  for (const value of BUDGETS) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${(value / 1000).toLocaleString()}k cells`;
    option.selected = value === plan.budget;
    budget.appendChild(option);
  }
  budget.addEventListener("change", () => {
    plan.budget = Number(budget.value);
    retune();
  });
  panel.appendChild(field("Sample to about", budget, `every ${plan.step} cell${plan.step === 1 ? "" : "s"}`));

  const geometry = document.createElement("select");
  for (const [value, label] of [
    ["point", "Cell centre (point)"],
    ["footprint", "Cell footprint (polygon)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === plan.geometry;
    geometry.appendChild(option);
  }
  geometry.disabled = state.georeference.kind === "none" || state.georeference.rotated;
  geometry.addEventListener("change", () => {
    plan.geometry = geometry.value;
    renderPlan();
  });
  panel.appendChild(
    field("Geometry", geometry, plan.geometry === "footprint" ? "one polygon per sampled block" : ""),
  );

  const skip = document.createElement("input");
  skip.type = "checkbox";
  skip.checked = plan.skipNodata;
  skip.addEventListener("change", () => {
    plan.skipNodata = skip.checked;
    renderPlan();
  });
  panel.appendChild(
    field(
      "Skip nodata cells",
      skip,
      variable.nodata === undefined ? "nothing declares a nodata value" : `nodata = ${variable.nodata}`,
    ),
  );

  const stats = planStats(variable, plan);
  const cost = document.createElement("p");
  cost.className = "zarr-cost";
  cost.textContent =
    `${stats.rowsOut.toLocaleString()} × ${stats.colsOut.toLocaleString()} = ${stats.rows.toLocaleString()} rows` +
    `${plan.skipNodata ? " at most" : ""} · ${stats.chunks.toLocaleString()} chunks · ~${formatBytes(stats.bytes)} to read`;
  panel.appendChild(cost);

  const refusal = planRefusal(variable, plan);
  elements.add.disabled = Boolean(refusal) || state.busy;
  setNote(refusal || "", Boolean(refusal));
}

/** Re-derive the stride from the window, then redraw. Every window edit lands here. */
function retune() {
  const plan = state.plan;
  if (plan.window.y[1] <= plan.window.y[0]) plan.window.y[1] = plan.window.y[0] + 1;
  if (plan.window.x[1] <= plan.window.x[0]) plan.window.x[1] = plan.window.x[0] + 1;
  const height = plan.window.y[1] - plan.window.y[0];
  const width = plan.window.x[1] - plan.window.x[0];
  plan.step =
    height * width <= plan.budget ? 1 : Math.max(1, Math.ceil(Math.sqrt((height * width) / plan.budget)));
  // The note is about the window the picker chose, not the one you now have.
  plan.narrowed = false;
  renderPlan();
}

/* ---------- opening and closing ---------- */

/**
 * The store's name, which is the `.zarr` segment and not the last one.
 *
 * A path can point inside a store — `…/gpw.zarr/band` — and naming the layer
 * after the last segment then gives you "band > band" in the rail.
 */
function storeNameOf(path) {
  const segments = path.replace(/\/$/, "").split("/").map(decodeURIComponent);
  return segments.findLast((segment) => /\.zarr$/i.test(segment)) || segments.at(-1) || "store.zarr";
}

/** Point the picker at a store, or at an array inside one. */
export async function openZarrPicker(path) {
  elements.modal.hidden = false;
  elements.title.textContent = path;
  elements.variables.replaceChildren();
  elements.plan.replaceChildren();
  elements.add.disabled = true;
  state = { store: null, variable: null, georeference: null, plan: null, busy: false };
  setNote("Opening the store…");

  try {
    state.store = await openZarrStore(resolveUrl(path), storeNameOf(path));
  } catch (err) {
    setNote(err.message, true);
    return;
  }

  elements.title.textContent = `${state.store.name} · Zarr v${state.store.zarrFormat}`;
  renderVariables();
  const first = state.store.variables.find((variable) => variable.readable);
  if (!first) {
    setNote("Nothing in this store is a two-dimensional array of numbers.", true);
    return;
  }
  await selectVariable(first);
}

export function close() {
  elements.modal.hidden = true;
}

export function initZarrPicker(config) {
  elements = config;
  onAdd = config.onAdd;

  elements.add.addEventListener("click", async () => {
    if (state.busy || !state.variable) return;
    state.busy = true;
    elements.add.disabled = true;
    try {
      await onAdd({
        store: state.store,
        variable: state.variable,
        plan: state.plan,
        georeference: state.georeference,
      });
      close();
    } catch (err) {
      setNote(err.message, true);
    } finally {
      state.busy = false;
      if (!elements.modal.hidden) renderPlan();
    }
  });

  elements.close.addEventListener("click", close);
  // Clicking the backdrop closes; clicking the panel must not.
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden && !state.busy) close();
  });
}

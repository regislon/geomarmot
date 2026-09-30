/*
 * The bucket browser.
 *
 * A folder-style view over a cloud bucket's flat key space, served by the local
 * server's /list endpoint rather than fetched from the browser: the storage
 * JSON API sends CORS headers on some buckets and not others, and going through
 * the server means listing works wherever your own credentials reach.
 *
 * Only one level is fetched at a time (`delimiter=/`), so a bucket with a
 * million objects costs one small page per folder you open.
 */

import { isSupportedName } from "./sources.js";
import { isZarrStore } from "./zarr.js";

/** Where the browser was last pointed, so a reload does not cost a retype. */
const LAST_PLACE_KEY = "geomarmot:bucket.v1";

let elements = {};
let onPick = null;
let state = { bucket: "", prefix: "", pageToken: "", loading: false };

function rememberPlace(bucket, prefix) {
  try {
    localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ bucket, prefix }));
  } catch {
    // Private windows and blocked site data are fine; it is only a convenience.
  }
}

function lastPlace() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_PLACE_KEY) || "null");
    if (stored?.bucket) return stored;
  } catch {
    /* ignore */
  }
  return { bucket: "", prefix: "" };
}

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Buckets / gs://bucket / a / b, rendered as clickable path segments. */
function renderBreadcrumb() {
  const bar = elements.path;
  bar.replaceChildren();
  const crumb = (label, go) => {
    const button = document.createElement("button");
    button.className = "crumb";
    button.textContent = label;
    button.addEventListener("click", go);
    bar.appendChild(button);
  };
  const separator = () => bar.appendChild(document.createTextNode("/"));

  crumb("Buckets", () => open("", ""));
  if (!state.bucket) return;
  separator();
  crumb(`gs://${state.bucket}`, () => open(state.bucket, ""));
  let walked = "";
  for (const part of state.prefix.split("/").filter(Boolean)) {
    walked += `${part}/`;
    const target = walked;
    separator();
    crumb(part, () => open(state.bucket, target));
  }
}

function row(icon, label, detail, onClick, disabled = false) {
  const item = document.createElement("button");
  item.className = `browse-row${disabled ? " disabled" : ""}`;
  item.disabled = disabled;
  item.innerHTML =
    `<span class="browse-icon">${icon}</span><span class="browse-name"></span>` + `<span class="browse-detail"></span>`;
  item.querySelector(".browse-name").textContent = label;
  item.querySelector(".browse-detail").textContent = detail;
  if (onClick) item.addEventListener("click", onClick);
  return item;
}

function setNote(message, isError = false) {
  elements.note.textContent = message || "";
  elements.note.classList.toggle("error", Boolean(isError));
}

/** The tree's root: no bucket chosen yet. */
function showBuckets() {
  state = { bucket: "", prefix: "", pageToken: "", loading: false };
  elements.bucket.value = "";
  renderBreadcrumb();
  elements.list.replaceChildren();
  rememberPlace("", "");
  setNote("Type a bucket name above and press Open.");
}

async function open(bucket, prefix, pageToken = "") {
  if (!bucket) return showBuckets();
  state = { bucket, prefix, pageToken, loading: true };
  elements.bucket.value = bucket;
  renderBreadcrumb();
  setNote("Listing…");
  if (!pageToken) elements.list.replaceChildren();

  let page;
  try {
    const url = new URL("list", window.location.href);
    url.searchParams.set("bucket", bucket);
    if (prefix) url.searchParams.set("prefix", prefix);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${response.status}`);
    }
    page = await response.json();
  } catch (err) {
    state.loading = false;
    setNote(err.message, true);
    return;
  }

  // Up one level — and out of the bucket, back to the tree root, from its top.
  if (!pageToken) {
    const parent = prefix.replace(/[^/]+\/$/, "");
    elements.list.appendChild(row("↰", "..", "", () => open(prefix ? bucket : "", parent)));
  }
  for (const folder of page.prefixes) {
    const name = folder.slice(prefix.length).replace(/\/$/, "");
    // A Zarr store is a folder, but walking into it only shows chunk files —
    // what anyone wants from it is the picker, so it is offered as a layer.
    if (isZarrStore(name)) {
      elements.list.appendChild(
        row("▦", name, "Zarr store", () => pick(`gs://${bucket}/${folder.replace(/\/$/, "")}`)),
      );
      continue;
    }
    elements.list.appendChild(row("📁", name, "", () => open(bucket, folder)));
  }
  for (const item of page.items) {
    const name = item.name.slice(prefix.length);
    const supported = isSupportedName(name);
    elements.list.appendChild(
      row(
        supported ? "📄" : "·",
        name,
        formatSize(item.size),
        // Unsupported files are shown rather than hidden — seeing that a folder
        // holds a .tif tells you where you are; it just cannot be opened.
        supported ? () => pick(`gs://${bucket}/${item.name}`) : null,
        !supported,
      ),
    );
  }

  if (page.nextPageToken) {
    elements.list.appendChild(row("⋯", "Load more", "", () => open(bucket, prefix, page.nextPageToken)));
  }

  state.loading = false;
  rememberPlace(bucket, prefix);
  const counts = `${page.prefixes.length} folders · ${page.items.length} files`;
  setNote(page.prefixes.length + page.items.length ? counts : "Nothing here.");
}

function pick(gsPath) {
  close();
  onPick?.(gsPath);
}

/** Reopens where you left off — picking two files from one folder is the norm. */
export function openBrowser() {
  elements.modal.hidden = false;
  const place = state.bucket ? state : lastPlace();
  open(place.bucket, place.prefix).catch((err) => setNote(err.message, true));
}

export function close() {
  elements.modal.hidden = true;
}

export function initBrowser(config) {
  elements = config;
  onPick = config.onPick;

  elements.go.addEventListener("click", () => open(elements.bucket.value.trim(), ""));
  elements.bucket.addEventListener("keydown", (event) => {
    if (event.key === "Enter") open(elements.bucket.value.trim(), "");
  });
  elements.close.addEventListener("click", close);
  // Clicking the backdrop closes; clicking the panel must not.
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden) close();
  });
}

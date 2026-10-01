/*
 * The Google Cloud Storage connector: a folder-style view over a bucket's flat
 * key space.
 *
 * Listing goes through the local server's /list endpoint rather than straight
 * from the browser: the storage JSON API sends CORS headers on some buckets and
 * not others, and going through the server means listing works wherever your
 * own credentials reach. Without the server (a static host) the connector says
 * so instead of listing.
 *
 * Only one level is fetched at a time (`delimiter=/`), so a bucket with a
 * million objects costs one small page per folder you open. The bucket and
 * folder you were in, and the buckets you opened recently, are remembered.
 */

import { isProxyAvailable } from "../../io/remote.js";
import { isSupportedName } from "../../io/sources.js";
import { isZarrStore } from "../../io/zarr/index.js";
import { prefs, remember, savePrefs } from "./prefs.js";
import { breadcrumb, formatSize, row, setNote } from "./rows.js";

let elements = {};
let onPick = null;
let state = { bucket: "", prefix: "" };

const note = (message, isError) => setNote(elements.note, message, isError);

function rememberPlace(bucket, prefix) {
  const gcs = prefs().gcs || {};
  savePrefs({ gcs: { ...gcs, bucket, prefix, recent: bucket ? remember(gcs.recent, bucket) : gcs.recent } });
  renderRecent();
}

function renderRecent() {
  elements.recent.replaceChildren(
    ...(prefs().gcs?.recent || []).map((bucket) => Object.assign(document.createElement("option"), { value: bucket })),
  );
}

function renderBreadcrumb() {
  const crumbs = [["Buckets", () => open("", "")]];
  if (state.bucket) {
    crumbs.push([`gs://${state.bucket}`, () => open(state.bucket, "")]);
    let walked = "";
    for (const part of state.prefix.split("/").filter(Boolean)) {
      walked += `${part}/`;
      const target = walked;
      crumbs.push([part, () => open(state.bucket, target)]);
    }
  }
  breadcrumb(elements.path, crumbs);
}

/** The tree's root: no bucket chosen yet. The recent buckets are one click away. */
function showBuckets() {
  state = { bucket: "", prefix: "" };
  elements.bucket.value = "";
  renderBreadcrumb();
  const recent = prefs().gcs?.recent || [];
  elements.list.replaceChildren(...recent.map((bucket) => row("🪣", bucket, "recent", () => open(bucket, ""))));
  note("Type a bucket name above and press Open.");
}

async function open(bucket, prefix, pageToken = "") {
  if (!bucket) return showBuckets();
  state = { bucket, prefix };
  elements.bucket.value = bucket;
  renderBreadcrumb();
  note("Listing…");
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
    note(err.message, true);
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
    // Unsupported files are shown rather than hidden — seeing that a folder
    // holds a .tif tells you where you are; it just cannot be opened.
    const go = supported ? () => pick(`gs://${bucket}/${item.name}`) : null;
    elements.list.appendChild(row(supported ? "📄" : "·", name, formatSize(item.size), go, !supported));
  }
  if (page.nextPageToken) {
    elements.list.appendChild(row("⋯", "Load more", "", () => open(bucket, prefix, page.nextPageToken)));
  }

  rememberPlace(bucket, prefix);
  const counts = `${page.prefixes.length} folders · ${page.items.length} files`;
  note(page.prefixes.length + page.items.length ? counts : "Nothing here.");
}

function pick(gsPath) {
  onPick?.(gsPath);
}

/** Shown when the pane is selected: reopens where you left off — two files from one folder is the norm. */
export function showGcs() {
  renderRecent();
  const proxy = isProxyAvailable();
  elements.list.hidden = !proxy;
  elements.bucket.parentElement.hidden = !proxy;
  if (!proxy) {
    note(
      "Buckets are read through the local GeoMarmot server, which this page does not have. Run GeoMarmot on your computer (see the README) to browse a bucket.",
      true,
    );
    return;
  }
  const place = state.bucket ? state : prefs().gcs || {};
  open(place.bucket || "", place.prefix || "").catch((err) => note(err.message, true));
}

export function initGcs(config) {
  elements = config;
  onPick = config.onPick;
  const go = () => isProxyAvailable() && open(elements.bucket.value.trim(), "");
  elements.go.addEventListener("click", go);
  elements.bucket.addEventListener("keydown", (event) => {
    if (event.key === "Enter") go();
  });
}

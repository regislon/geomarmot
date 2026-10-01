/*
 * The Google Cloud Storage connector: a folder-style view over a bucket's flat
 * key space.
 *
 * Listing goes through the local server's /list endpoint rather than straight
 * from the browser: the storage JSON API sends CORS headers on some buckets and
 * not others, and going through the server means listing works wherever your
 * own credentials reach. Without the server (the GitHub Pages demo) it lists
 * straight from the browser instead, with a Google sign-in (google.js).
 *
 * Only one level is fetched at a time (`delimiter=/`), so a bucket with a
 * million objects costs one small page per folder you open. The bucket and
 * folder you were in, and the buckets you opened recently, are remembered.
 */

import { isProxyAvailable } from "../../io/remote.js";
import { isSupportedName } from "../../io/sources.js";
import { isZarrStore } from "../../io/zarr/index.js";
import { setStatus } from "../dom.js";
import { hideProgress, readWithProgress } from "../progress.js";
import {
  STORAGE_API,
  builtInClientId,
  clientId,
  prepareSignIn,
  setClientId,
  signIn,
  signOut,
  signedIn,
  storageFetch,
} from "./google.js";
import { prefs, remember, savePrefs } from "./prefs.js";
import { breadcrumb, formatSize, row, setNote } from "./rows.js";

let elements = {};
let onPick = null;
let onFiles = null;
let onClose = null;
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
    page = await listPage(bucket, prefix, pageToken);
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
      const store = `gs://${bucket}/${folder.replace(/\/$/, "")}`;
      // Read chunk by chunk, which the Google sign-in does not cover yet.
      if (isProxyAvailable()) elements.list.appendChild(row("▦", name, "Zarr store", () => pick(store)));
      else elements.list.appendChild(row("▦", name, "Zarr: needs the local server", null, true));
      continue;
    }
    elements.list.appendChild(row("📁", name, "", () => open(bucket, folder)));
  }
  for (const item of page.items) {
    const name = item.name.slice(prefix.length);
    const supported = isSupportedName(name);
    // Unsupported files are shown rather than hidden — seeing that a folder
    // holds a .tif tells you where you are; it just cannot be opened.
    const go = supported ? () => pick(`gs://${bucket}/${item.name}`, item.size) : null;
    elements.list.appendChild(row(supported ? "📄" : "·", name, formatSize(item.size), go, !supported));
  }
  if (page.nextPageToken) {
    elements.list.appendChild(row("⋯", "Load more", "", () => open(bucket, prefix, page.nextPageToken)));
  }

  rememberPlace(bucket, prefix);
  const counts = `${page.prefixes.length} folders · ${page.items.length} files`;
  note(page.prefixes.length + page.items.length ? counts : "Nothing here.");
}

/** One level of a bucket, as { prefixes, items: [{ name, size }], nextPageToken }. */
async function listPage(bucket, prefix, pageToken) {
  if (!isProxyAvailable()) {
    // Straight from the browser, with the Google sign-in's token.
    const url = new URL(`${STORAGE_API}/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("fields", "prefixes,items(name,size),nextPageToken");
    if (prefix) url.searchParams.set("prefix", prefix);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await (await storageFetch(url)).json();
    return {
      prefixes: page.prefixes || [],
      items: (page.items || []).map((item) => ({ name: item.name, size: Number(item.size) })),
      nextPageToken: page.nextPageToken || "",
    };
  }
  const url = new URL("list", window.location.href);
  url.searchParams.set("bucket", bucket);
  if (prefix) url.searchParams.set("prefix", prefix);
  if (pageToken) url.searchParams.set("page_token", pageToken);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${response.status}`);
  }
  return response.json();
}

/** Above this, downloading a whole file into the tab asks first. */
const LARGE = 1024 ** 3;

/**
 * Read gs://bucket/key through the Google sign-in: the whole object, with the
 * token as a header, then opened like a file from this computer. The token
 * never reaches DuckDB or a URL, so the layer outlives it.
 */
export async function downloadWithGoogle(gsPath, size = 0) {
  const [, bucket, key] = gsPath.match(/^gs:\/\/([^/]+)\/(.+)$/) || [];
  if (!bucket) throw new Error(`Not a gs:// path: ${gsPath}`);
  const name = key.split("/").pop();
  if (size > LARGE && !window.confirm(`${name} is ${formatSize(size)}. Download all of it into this tab?`)) return;
  const url = `${STORAGE_API}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
  let bytes;
  try {
    bytes = await readWithProgress(await storageFetch(url), `Downloading ${name}`);
  } finally {
    hideProgress();
  }
  await onFiles?.([new File([bytes], name)], { origin: "gcs" });
}

function pick(gsPath, size) {
  if (isProxyAvailable()) return onPick?.(gsPath);
  onClose?.();
  downloadWithGoogle(gsPath, size).catch((err) => setStatus(`${gsPath}: ${err.message}`, true));
}

/** Without the server: the client ID, then the sign-in, then the bucket. */
function renderGoogle() {
  const id = clientId();
  const signed = signedIn();
  const g = elements.google;
  g.root.hidden = false;
  // Signed in, the card shrinks to a line above the bucket; otherwise it is the whole pane.
  g.root.classList.toggle("signed", signed);
  g.signIn.hidden = signed;
  g.signOut.hidden = !signed;
  g.clientRow.hidden = !g.editing;
  g.change.hidden = Boolean(builtInClientId()) || g.editing || signed;
  g.text.textContent = signed
    ? "Signed in with Google, read-only, until the tab closes or about an hour passes."
    : g.editing
      ? "This site is not registered with Google yet. Paste its OAuth client ID, set up once by whoever runs the site (Using GeoMarmot ▸ Google Cloud Storage explains how)."
      : "Sign in with your Google account to see the buckets it can read. GeoMarmot only asks to read, and keeps the sign-in in this tab.";
  elements.list.hidden = !signed;
  elements.bucket.parentElement.hidden = !signed;
  elements.path.hidden = !signed;
  if (!signed) {
    note("");
    if (id) prepareSignIn().catch((err) => note(err.message, true));
  }
  return signed;
}

/** Shown when the pane is selected: reopens where you left off — two files from one folder is the norm. */
export function showGcs() {
  renderRecent();
  elements.google.root.hidden = true;
  elements.path.hidden = false;
  if (!isProxyAvailable() && !renderGoogle()) return;
  elements.list.hidden = false;
  elements.bucket.parentElement.hidden = false;
  const place = state.bucket ? state : prefs().gcs || {};
  open(place.bucket || "", place.prefix || "").catch((err) => note(err.message, true));
}

export function initGcs(config) {
  elements = config;
  onPick = config.onPick;
  onFiles = config.onFiles;
  onClose = config.onClose;
  const go = () => (isProxyAvailable() || signedIn()) && open(elements.bucket.value.trim(), "");
  elements.go.addEventListener("click", go);
  elements.bucket.addEventListener("keydown", (event) => {
    if (event.key === "Enter") go();
  });
  const g = elements.google;
  const saveId = () => {
    if (!g.clientInput.value.trim()) return;
    setClientId(g.clientInput.value);
    g.editing = false;
    showGcs();
  };
  g.clientSave.addEventListener("click", saveId);
  g.clientInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveId();
  });
  const setUp = () => {
    g.editing = true;
    g.clientInput.value = clientId();
    renderGoogle();
    g.clientInput.focus();
  };
  g.change.addEventListener("click", setUp);
  g.signIn.addEventListener("click", () => {
    // Not registered yet: the button leads to the one-time setup instead of a popup that would fail.
    if (!clientId()) return setUp();
    signIn()
      .then(showGcs)
      .catch((err) => note(err.message, true));
  });
  g.signOut.addEventListener("click", () => {
    signOut();
    state = { bucket: "", prefix: "" };
    showGcs();
  });
}

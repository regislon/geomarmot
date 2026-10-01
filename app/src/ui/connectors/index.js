/*
 * Connectors: the ways to reach data, in one window behind the Connect button.
 *
 * A connector is where the files are — this computer (the default), a Google
 * Cloud Storage bucket, a web address, later a database. Each has a pane that
 * ends in the same place a dropped file does: a layer in the rail. The window
 * remembers the connector you used last, and each connector its own places
 * (prefs.js). Dragging files onto the page still works without it.
 */

import { isProxyAvailable } from "../../io/remote.js";
import { initComputer, showComputer } from "./computer.js";
import { setStatus } from "../dom.js";
import { downloadWithGoogle, initGcs, showGcs } from "./gcs.js";
import { signedIn } from "./google.js";
import { prefs, remember, savePrefs } from "./prefs.js";
import { row } from "./rows.js";

const CONNECTORS = [
  { id: "computer", icon: "💻", name: "This computer", detail: "Files and folders" },
  { id: "gcs", icon: "☁️", name: "Google Cloud Storage", detail: "Browse a bucket", server: true },
  { id: "url", icon: "🔗", name: "Web address", detail: "A link to a file or a Zarr store" },
  { id: "database", icon: "🗄️", name: "Database", detail: "Not available yet", soon: true },
];

let elements = {};
let current = null;
let loadUrl = null;

function renderList() {
  elements.list.replaceChildren(
    ...CONNECTORS.map((connector) => {
      const button = document.createElement("button");
      button.className = "connect-item";
      button.dataset.connector = connector.id;
      button.setAttribute("aria-pressed", String(connector.id === current));
      const detail = connector.server && !isProxyAvailable() ? "Sign in with Google" : connector.detail;
      button.innerHTML = `<span class="connect-icon">${connector.icon}</span><span><span class="connect-name"></span><span class="connect-detail"></span></span>`;
      button.querySelector(".connect-name").textContent = connector.name;
      button.querySelector(".connect-detail").textContent = detail;
      button.classList.toggle("soon", Boolean(connector.soon));
      button.addEventListener("click", () => select(connector.id));
      return button;
    }),
  );
}

function renderRecentUrls() {
  const recent = prefs().url?.recent || [];
  elements.urlRecent.hidden = !recent.length;
  elements.urlRecent.replaceChildren(
    ...recent.map((url) => row("🔗", url, "recent", () => ((elements.urlInput.value = url), submitUrl()))),
  );
}

function select(id) {
  current = CONNECTORS.some((connector) => connector.id === id) ? id : "computer";
  savePrefs({ last: current });
  renderList();
  for (const connector of CONNECTORS) elements.panes[connector.id].hidden = connector.id !== current;
  if (current === "computer") showComputer();
  if (current === "gcs") showGcs();
  if (current === "url") {
    renderRecentUrls();
    elements.urlInput.focus();
  }
}

function submitUrl() {
  const url = elements.urlInput.value.trim();
  if (!url) return;
  // A signed link carries its credential in the query string: it is opened, never kept.
  if (!url.includes("?")) savePrefs({ url: { recent: remember(prefs().url?.recent, url) } });
  elements.urlInput.value = "";
  closeConnect();
  // Without the server, a gs:// path can still be read through the Google sign-in.
  if (/^gs:\/\//.test(url) && !isProxyAvailable() && signedIn()) {
    downloadWithGoogle(url).catch((err) => setStatus(`${url}: ${err.message}`, true));
    return;
  }
  loadUrl(url);
}

/** Open the window on `id`, or on the connector used last. */
export function openConnect(id = prefs().last) {
  elements.modal.hidden = false;
  select(id);
}

export function closeConnect() {
  elements.modal.hidden = true;
}

/**
 * @param {object} config  the window's elements, and where picks go:
 *   `onFiles(files)` for local files, `onUrl(url)` for links and bucket paths,
 *   `chooseFiles()` to open the browser's file dialog.
 */
export function initConnectors(config) {
  elements = config;
  loadUrl = config.onUrl;
  const done = (fn) => (value) => {
    closeConnect();
    fn(value);
  };
  initComputer({ ...config.computer, onFiles: done(config.onFiles), chooseFiles: done(config.chooseFiles) });
  initGcs({ ...config.gcs, onPick: done(config.onUrl), onFiles: config.onFiles, onClose: closeConnect });
  elements.urlGo.addEventListener("click", submitUrl);
  elements.urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitUrl();
  });
  elements.close.addEventListener("click", closeConnect);
  // Clicking the backdrop closes; clicking the panel must not.
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) closeConnect();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden) closeConnect();
  });
}

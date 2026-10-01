/*
 * The computer connector: files on this machine, read in the browser and never
 * uploaded.
 *
 * "Choose files…" is the browser's own file dialog, which works everywhere.
 * Where the browser has the File System Access API (Chrome, Edge), a folder can
 * be opened too and walked like the bucket connector. The folder's handle is
 * kept in IndexedDB so it can be reopened after a reload; the browser asks
 * again before it lets the page read it.
 */

import { isSupportedName } from "../../io/sources.js";
import { isZarrStore } from "../../io/zarr/index.js";
import { savePrefs } from "./prefs.js";
import { breadcrumb, formatSize, row, setNote } from "./rows.js";

const DB = "geomarmot-connectors";
const STORE = "handles";
const FOLDER = "computer.folder";

let elements = {};
let onFiles = null;
let trail = []; // directory handles from the opened folder down to the current one

const note = (message, isError) => setNote(elements.note, message, isError);
export const canOpenFolders = () => typeof window.showDirectoryPicker === "function";

function handles(mode, action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE, mode);
      const result = action(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(result.result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

const storedFolder = () => handles("readonly", (store) => store.get(FOLDER)).catch(() => null);
const storeFolder = (handle) => handles("readwrite", (store) => store.put(handle, FOLDER)).catch(() => null);

async function show() {
  const here = trail.at(-1);
  breadcrumb(
    elements.path,
    trail.map((handle, depth) => [handle.name, () => ((trail = trail.slice(0, depth + 1)), show())]),
  );
  note("Listing…");
  const folders = [];
  const files = [];
  try {
    for await (const entry of here.values()) (entry.kind === "directory" ? folders : files).push(entry);
  } catch (err) {
    note(err.message, true);
    return;
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const list = [];
  if (trail.length > 1) list.push(row("↰", "..", "", () => ((trail = trail.slice(0, -1)), show())));
  for (const folder of folders.sort(byName)) {
    // Zarr is read through ranged URLs, which a local folder does not have.
    if (isZarrStore(folder.name)) list.push(row("▦", folder.name, "Zarr: open it by link", null, true));
    else list.push(row("📁", folder.name, "", () => (trail.push(folder), show())));
  }
  for (const entry of files.sort(byName)) {
    const supported = isSupportedName(entry.name);
    const item = row(supported ? "📄" : "·", entry.name, "", supported ? () => pick(entry) : null, !supported);
    list.push(item);
    // Sizes cost one call per file; fill them in without holding up the list.
    entry
      .getFile()
      .then((file) => (item.querySelector(".browse-detail").textContent = formatSize(file.size)))
      .catch(() => {});
  }
  elements.list.replaceChildren(...list);
  elements.list.hidden = false;
  note(`${folders.length} folders · ${files.length} files`);
}

async function pick(entry) {
  try {
    onFiles?.([await entry.getFile()]);
  } catch (err) {
    note(err.message, true);
  }
}

async function openFolder(handle) {
  trail = [handle];
  savePrefs({ computer: { folder: handle.name } });
  elements.reopen.hidden = true;
  await show();
}

/** Shown when the pane is selected. */
export async function showComputer() {
  elements.folder.hidden = !canOpenFolders();
  if (trail.length) return show();
  elements.list.hidden = true;
  elements.path.replaceChildren();
  note(canOpenFolders() ? "" : "This browser can open files, not folders. Drag and drop works too.");
  const saved = canOpenFolders() ? await storedFolder() : null;
  elements.reopen.hidden = !saved;
  if (saved) {
    elements.reopen.textContent = `Reopen ${saved.name}`;
    elements.reopen.onclick = async () => {
      if ((await saved.requestPermission({ mode: "read" })) === "granted") openFolder(saved);
      else note("The browser did not allow reading that folder.", true);
    };
  }
}

export function initComputer(config) {
  elements = config;
  onFiles = config.onFiles;
  elements.files.addEventListener("click", () => config.chooseFiles());
  elements.folder.addEventListener("click", async () => {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "geomarmot", mode: "read" });
    } catch {
      return; // cancelled
    }
    await storeFolder(handle);
    openFolder(handle);
  });
}

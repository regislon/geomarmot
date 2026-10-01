/*
 * Workspaces kept in this browser: named saves of the graph, next to the one
 * silent autosave.
 *
 * A workspace is what a graph file holds — the nodes, their settings and the
 * generated transformers they use — not the data: the files its Readers read
 * are loaded again after opening, as with a file. Workspaces live in this
 * browser's localStorage, so they stay on this machine, in this browser
 * profile, and go when its site data is cleared. Being written only by this
 * app, they are trusted like the autosave (a node's unrestricted SQL is kept).
 */

import { serialize } from "../core/graph/index.js";
import { h } from "./inspector/widgets.js";
import { el, setStatus } from "./dom.js";
import { openSaved } from "./persistence.js";

const STORAGE_KEY = "geomarmot:workspaces.v1";

/** The workspace the graph was last opened from or saved to, for Save without a name. */
let current = null;

/** @returns {Record<string, { savedAt: string, graph: any }>} */
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAll(all) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Forget which workspace is open (after New, or opening a file). */
export function detachWorkspace() {
  current = null;
}

export function currentWorkspace() {
  return current;
}

function save(name) {
  const all = readAll();
  all[name] = { savedAt: new Date().toISOString(), graph: serialize() };
  try {
    writeAll(all);
  } catch (err) {
    setStatus(`Could not save in this browser: ${err.message}`, true);
    return false;
  }
  current = name;
  setStatus(`Saved “${name}” in this browser.`);
  return true;
}

const modal = () => el("workspace-modal");
const close = () => (modal().hidden = true);

function show(title, ...children) {
  el("workspace-title").textContent = title;
  el("workspace-body").replaceChildren(...children);
  modal().hidden = false;
}

/** Save to the browser: under the current name, or ask for one (always, with `ask`). */
export function saveToBrowser({ ask = false } = {}) {
  if (current && !ask) return save(current);
  const input = h("input", { id: "workspace-name", type: "text", placeholder: "Workspace name", maxlength: "120" });
  input.value = current || "";
  const warn = h("p", { class: "warn" });
  const confirm = h("button", { id: "workspace-save", class: "primary", text: "Save" });
  const update = () => {
    const name = input.value.trim();
    const taken = name && name !== current && name in readAll();
    warn.textContent = taken ? `A workspace called “${name}” is already saved; saving replaces it.` : "";
    confirm.textContent = taken ? "Replace" : "Save";
    confirm.disabled = !name;
  };
  const submit = (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (name && save(name)) close();
  };
  input.addEventListener("input", update);
  const form = h("form", { class: "workspace-form", onsubmit: submit }, [
    h("label", {}, [h("span", { text: "Save this workspace in this browser as" }), input]),
    warn,
    h("div", { class: "actions" }, [confirm]),
  ]);
  update();
  show("Save to this browser", form);
  input.focus();
  input.select();
}

/** List the workspaces saved in this browser, to open or delete one. */
export function openFromBrowser() {
  const entries = Object.entries(readAll()).sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
  if (!entries.length) {
    show(
      "Open from this browser",
      h("p", {
        class: "muted",
        text: "No workspace is saved in this browser yet. Save one with Save ▸ To this browser.",
      }),
    );
    return;
  }
  const rows = entries.map(([name, entry]) => {
    const nodes = entry.graph?.nodes?.length ?? 0;
    const when = new Date(entry.savedAt).toLocaleString();
    return h("div", { class: "workspace-row" }, [
      h("div", { class: "name", text: name }, [
        h("span", { class: "meta", text: `${nodes} node${nodes === 1 ? "" : "s"} · saved ${when}` }),
      ]),
      h("button", {
        class: "primary",
        text: "Open",
        "data-workspace": name,
        onclick: async () => {
          close();
          try {
            await openSaved(structuredClone(entry.graph), { trusted: true });
            current = name;
            setStatus(`Opened “${name}”. Load the files its Readers need.`);
          } catch (err) {
            setStatus(`Could not open “${name}”: ${err.message}`, true);
          }
        },
      }),
      h("button", {
        text: "Delete",
        title: `Delete “${name}” from this browser`,
        onclick: () => {
          if (!window.confirm(`Delete the workspace “${name}” from this browser?`)) return;
          const all = readAll();
          delete all[name];
          writeAll(all);
          if (current === name) current = null;
          openFromBrowser();
        },
      }),
    ]);
  });
  show(
    "Open from this browser",
    h("p", {
      class: "muted",
      text: "Workspaces saved in this browser, on this computer. Data files are loaded again after opening.",
    }),
    ...rows,
  );
}

export function initWorkspaces() {
  el("workspace-close").addEventListener("click", close);
  modal().addEventListener("click", (event) => {
    if (event.target === modal()) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal().hidden) close();
  });
}

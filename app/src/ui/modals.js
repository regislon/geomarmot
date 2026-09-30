/* The help and feature-geometry modals. */

import { LONLAT } from "../core/schema.js";
import { describeFeature, renderFeature } from "./geominfo.js";
import { currentSheet } from "./table.js";
import { el } from "./dom.js";

/* ---------- help modal ---------- */

/** A transformer's long explanation, out of the panel and into a modal. */
export function showHelp(help) {
  el("help-title").textContent = help.title || "About";
  const body = el("help-body");
  body.replaceChildren();
  for (const paragraph of help.intro || []) {
    body.appendChild(Object.assign(document.createElement("p"), { textContent: paragraph }));
  }
  if (help.code) {
    body.appendChild(
      Object.assign(document.createElement("pre"), { className: "syntax-text", textContent: help.code }),
    );
  }
  el("help-modal").hidden = false;
}

/* ---------- feature geometry modal ---------- */

/**
 * What one feature's geometry is, from the table's per-row button.
 *
 * The CRS comes from the sheet on screen rather than from the picked row: the
 * row carries coordinates and nothing that says what they mean, and after a
 * Reprojector that difference is the whole point.
 */
export async function showGeometryInfo(pick) {
  const body = el("geometry-body");
  body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Reading…" }));
  el("geometry-modal").hidden = false;
  try {
    renderFeature(body, await describeFeature(pick, currentSheet()?.crs || LONLAT));
  } catch (err) {
    body.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: err.message }));
  }
}

export function initGeometryModal() {
  const modal = el("geometry-modal");
  el("geometry-close").addEventListener("click", () => (modal.hidden = true));
  // The backdrop closes; the panel must not.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

export function initHelpModal() {
  const modal = el("help-modal");
  el("help-close").addEventListener("click", () => (modal.hidden = true));
  // The backdrop closes; the panel must not.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

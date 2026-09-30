/* Dropping files on the page, or on the canvas to get a Reader where they land. */

import { el } from "./dom.js";
import { loadFiles } from "./rail.js";

/* ---------- drag and drop ---------- */

export function initDropZone() {
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("dragover", (event) => {
    stop(event);
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget) return;
    document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (event) => {
    stop(event);
    document.body.classList.remove("dragging");
    const onCanvas = Boolean(event.target?.closest?.("#canvas-wrap"));
    loadFiles([...event.dataTransfer.files], onCanvas ? { x: event.clientX, y: event.clientY } : null);
  });
  el("dropzone").addEventListener("click", () => el("file-input").click());
  el("file-input").addEventListener("change", (event) => loadFiles([...event.target.files]));
}

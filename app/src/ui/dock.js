/* The bottom dock: its height and the split between the grid and the map. */

import { resizeMap } from "./map/index.js";
import { el } from "./dom.js";

/* ---------- dock resizing ---------- */

/** Keep in step with the 6px splitter column in #dock. */
const SPLITTER_WIDTH = 6;

export function initDockResizer() {
  const resizer = el("dock-resizer");
  const shell = el("shell");
  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const move = (moveEvent) => {
      const height = Math.min(Math.max(120, window.innerHeight - moveEvent.clientY), window.innerHeight - 220);
      shell.style.setProperty("--dock-height", `${height}px`);
      resizeMap();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });
}

/** The table/map split. Sets the table's width; the map absorbs the remainder. */
export function initDockSplitter() {
  const splitter = el("dock-splitter");
  const dock = el("dock");
  const MIN_PANE = 220;

  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    document.body.classList.add("splitting");
    const left = dock.getBoundingClientRect().left;
    const move = (moveEvent) => {
      const available = dock.clientWidth - SPLITTER_WIDTH;
      const width = Math.min(Math.max(MIN_PANE, moveEvent.clientX - left), available - MIN_PANE);
      dock.style.setProperty("--table-width", `${Math.round(width)}px`);
      resizeMap();
    };
    const stop = () => {
      document.body.classList.remove("splitting");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });

  // Back to an even split: dropping the property restores the 1fr default.
  splitter.addEventListener("dblclick", () => {
    dock.style.removeProperty("--table-width");
    resizeMap();
  });
}

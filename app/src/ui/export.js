/* Run: writing every connected Writer (the toolbar's Run button, #btn-export). */

import { cancelMain } from "../core/duck.js";
import { graph, upstreamCrs, upstreamView } from "../core/graph/index.js";
import { transformerFor } from "../../../transformers/index.js";
import { flushPendingCompile, retainShown, views } from "./compile-loop.js";
import { el, setStatus } from "./dom.js";
import { beginTask } from "./progress.js";

/* ---------- run ---------- */

/** Writers with something connected — the ones that can actually produce a file. */
export function connectedWriters() {
  return graph.nodes.filter((node) => node.type === "Writer" && upstreamView(node.id, "input", views));
}

export async function exportWriters(writers) {
  const button = el("btn-export");
  button.disabled = true;
  // Exports have no timeout — a big file takes as long as it takes — but can be stopped.
  const cancel = el("btn-cancel");
  cancel.hidden = false;
  cancel.onclick = () => {
    cancel.disabled = true;
    setStatus("Stopping the export…");
    cancelMain().catch((err) => setStatus(err.message, true));
  };
  let lease = null;
  const task = beginTask("Preparing to write…", { delay: 0 });
  try {
    await flushPendingCompile();
    // Held for the whole export, so no recompile can drop what is being written.
    lease = retainShown();
    const written = [];
    for (const [index, writer] of writers.entries()) {
      const view = upstreamView(writer.id, "input", lease.views);
      if (!view) continue;
      setStatus(`Writing ${writer.params.filename || "output"}…`);
      const of = writers.length > 1 ? ` (file ${index + 1} of ${writers.length})` : "";
      task.update(
        `Writing ${writer.params.filename || "output"}${of}…`,
        writers.length > 1 ? index / writers.length : null,
      );
      const sink = transformerFor(writer.type);
      written.push(
        await sink.write({
          nodeId: writer.id,
          params: structuredClone(writer.params),
          inputs: { input: view },
          incomingCrs: upstreamCrs(writer.id, "input", lease.crsByNode),
        }),
      );
    }
    if (!written.length) {
      setStatus("Nothing to write — no Writer is connected.", true);
      return;
    }
    const note = written.find((result) => result.note)?.note;
    setStatus(note || `Wrote ${written.map((result) => result.file).join(", ")}.`, Boolean(note));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    task.end();
    lease?.release();
    cancel.hidden = true;
    cancel.disabled = false;
    updateExportButton();
  }
}

export function updateExportButton() {
  const writers = connectedWriters();
  const button = el("btn-export");
  button.disabled = writers.length === 0;
  button.title = writers.length
    ? `Write ${writers.length === 1 ? "1 file" : `${writers.length} files`}`
    : "Connect a Writer node to export";
}

/* Export: running the connected Writers. */

import { graph, upstreamCrs, upstreamView } from "../core/graph.js";
import { runWriter } from "../io/writers/index.js";
import { crsByNode, flushPendingCompile, views } from "./compile-loop.js";
import { el, setStatus } from "./dom.js";

/* ---------- run ---------- */

/** Writers with something connected — the ones that can actually produce a file. */
export function connectedWriters() {
  return graph.nodes.filter((node) => node.type === "Writer" && upstreamView(node.id, "input", views));
}

export async function exportWriters(writers) {
  const button = el("btn-export");
  button.disabled = true;
  try {
    await flushPendingCompile();
    const written = [];
    for (const writer of writers) {
      const view = upstreamView(writer.id, "input", views);
      if (!view) continue;
      setStatus(`Writing ${writer.params.filename || "output"}…`);
      written.push(
        await runWriter(view, writer.params.format || "Parquet", writer.params.filename, {
          crs: upstreamCrs(writer.id, "input", crsByNode),
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

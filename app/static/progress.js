/*
 * The loading bar under the toolbar.
 *
 * For the operations long enough that a still screen reads as a hang: a big
 * workbook being downloaded, parsed and flattened, or an Excel file being
 * written. A known fraction fills the bar; `null` means the stage has no way
 * to report how far along it is (SheetJS parsing, say), and the bar sweeps
 * instead — still moving, so still visibly alive.
 */

let elements = null;

export function initProgress(config) {
  elements = config;
}

/** Show `label`, with `fraction` in [0, 1] or null for "working, no estimate". */
export function showProgress(label, fraction = null) {
  if (!elements) return;
  elements.root.hidden = false;
  elements.label.textContent = label;
  const known = typeof fraction === "number" && Number.isFinite(fraction);
  elements.root.classList.toggle("indeterminate", !known);
  elements.fill.style.width = known ? `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` : "";
}

export function hideProgress() {
  if (!elements) return;
  elements.root.hidden = true;
  elements.fill.style.width = "0%";
}

/**
 * Read a response body with the bar following the download.
 *
 * `fetch().arrayBuffer()` says nothing until the last byte lands, which for a
 * 50 MB workbook through the GCS proxy is a long silence. Reading the stream
 * gives a fraction whenever the server sent a Content-Length.
 */
export async function readWithProgress(response, label) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    const megabytes = (received / 1e6).toFixed(1);
    showProgress(
      total ? `${label} — ${megabytes} of ${(total / 1e6).toFixed(1)} MB` : `${label} — ${megabytes} MB`,
      total ? received / total : null,
    );
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

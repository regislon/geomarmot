// @ts-check
/*
 * The engine's memory ceiling, so running out gives a DuckDB error rather than
 * a crashed tab.
 *
 * DuckDB-Wasm is 32-bit WebAssembly: 4 GB is the most it can address, on any
 * machine, and it cannot spill to disk. Within that, it takes 60% of the
 * memory the browser reports. Chrome and Edge report it (up to 8 GB);
 * Firefox and Safari do not, for privacy, so a desktop is taken to have 8 GB
 * and a phone or tablet 4 GB.
 */

const MAX_GB = 4;

function deviceGb() {
  const reported = /** @type {any} */ (navigator).deviceMemory;
  if (reported) return reported;
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 4 : 8;
}

/** "4GB": what `SET memory_limit` gets. */
export function memoryLimit() {
  return `${Math.max(1, Math.min(MAX_GB, Math.floor(deviceGb() * 0.6)))}GB`;
}

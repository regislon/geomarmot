// @ts-check
/*
 * Installing a generated transformer: validate its spec, build it, register it,
 * keep it. The only way one enters the registry — whether the assistant just
 * wrote it, it was kept in this browser, or it came in a graph file.
 */

import { registerGenerated } from "../../../../transformers/index.js";
import { specToTransformer } from "./runtime.js";
import { loadCustoms, saveCustom } from "./store.js";
import { validateSpec } from "./validate.js";

const listeners = new Set();

/** Hear when a generated transformer is installed (the palette re-renders). */
export function onCustomInstalled(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {any} spec
 * @param {number} level   the data level of the conversation that wrote it (1 for a file of unknown origin)
 * @param {{ persist?: boolean }} [options]
 */
export async function installCustom(spec, level, { persist = true } = {}) {
  const verdict = await validateSpec(spec);
  if (!verdict.ok) return verdict;
  const origin = [1, 2, 3].includes(level) ? level : 1;
  const transformer = specToTransformer(spec, { level: origin });
  registerGenerated(transformer);
  if (persist) await saveCustom({ id: spec.id, spec, level: origin });
  for (const listener of listeners) listener(transformer);
  return { ok: true, problems: [], transformer };
}

/** Install every generated transformer kept in this browser. */
export async function installStoredCustoms() {
  for (const entry of await loadCustoms()) {
    const result = await installCustom(entry.spec, entry.level, { persist: false });
    if (!result.ok) console.warn(`The kept transformer ${entry.id} no longer validates`, result.problems);
  }
}

/** Install the generated transformers a saved graph carries, before the graph is loaded. */
export async function installGraphCustoms(saved) {
  const refused = [];
  for (const entry of Array.isArray(saved?.custom) ? saved.custom : []) {
    const result = await installCustom(entry?.spec, Number(entry?.level) || 1);
    if (!result.ok) refused.push(entry?.spec?.id || "(unnamed)");
  }
  return refused;
}

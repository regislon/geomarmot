// @ts-check
/*
 * Assistant settings other than keys: provider, route, model, effort and the
 * data level. Kept in localStorage; keys live in ai/keys.js.
 *
 * The data level decides what may leave the browser (ai/gate.js):
 *   1  schema only: column names and types, counts, CRS, structured errors
 *   2  plus per-column statistics and a few top values
 *   3  plus sample rows, preview rows and raw error text
 * It starts at 1, the most private. Listeners hear every change with the
 * previous settings, so the conversation can end when the level is lowered.
 */

import { ADAPTERS } from "./provider.js";

const STORAGE_KEY = "geomarmot:ai-settings.v1";
export const LEVELS = [1, 2, 3];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** @typedef {{ provider: "anthropic"|"openai", transport: "browser"|"server", model: string, effort: string, level: 1|2|3 }} Settings */

/** @type {Settings} */
export const DEFAULTS = Object.freeze({
  provider: "anthropic",
  transport: "browser",
  model: ADAPTERS.anthropic.DEFAULT_MODEL,
  effort: "high",
  level: 1,
});

const listeners = new Set();

function read() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Keep only known fields with valid values, so a hand-edited store cannot smuggle anything in. */
function clean(raw) {
  const out = { ...DEFAULTS };
  if (raw.provider in ADAPTERS) out.provider = raw.provider;
  if (raw.transport === "browser" || raw.transport === "server") out.transport = raw.transport;
  if (typeof raw.model === "string") out.model = raw.model.slice(0, 100);
  if (EFFORTS.includes(raw.effort)) out.effort = raw.effort;
  if (LEVELS.includes(raw.level)) out.level = raw.level;
  return out;
}

let current = clean(read());

/** @returns {Settings} */
export function getSettings() {
  return { ...current };
}

/** Change some settings, save them, and tell the listeners. */
export function updateSettings(patch) {
  const previous = current;
  const next = clean({ ...current, ...patch });
  if (patch.provider && patch.provider !== previous.provider && !("model" in patch)) {
    next.model = ADAPTERS[next.provider].DEFAULT_MODEL;
  }
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage off: settings last as long as the page */
  }
  for (const listener of listeners) listener(next, previous);
  return getSettings();
}

/** Hear every change: listener(next, previous). Returns an unsubscribe function. */
export function onSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

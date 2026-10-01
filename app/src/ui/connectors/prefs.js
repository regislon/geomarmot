// @ts-check
/*
 * What the connectors remember in this browser (localStorage): the connector
 * used last, the bucket and folder you were in, recent buckets and links.
 * Never a credential — the bucket connector uses the local server's own
 * access, and links with a query string (signed URLs) are not kept.
 */

const KEY = "geomarmot:connectors.v1";
const RECENT = 8;

/** @typedef {{ last?: string, gcs?: { bucket?: string, prefix?: string, recent?: string[] }, url?: { recent?: string[] }, computer?: { folder?: string } }} Prefs */

/** @returns {Prefs} */
export function prefs() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

/** Merge `patch` into one connector's prefs (or the top level). */
export function savePrefs(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs(), ...patch }));
  } catch {
    // Private windows and blocked site data are fine; it is only a convenience.
  }
}

/** `value` first in `list`, without duplicates, at most a handful. */
export const remember = (list = [], value) => [value, ...list.filter((item) => item !== value)].slice(0, RECENT);

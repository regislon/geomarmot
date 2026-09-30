// @ts-check
/*
 * API keys the user types into the assistant settings.
 *
 * A key is kept in sessionStorage by default: it lasts as long as the tab and
 * is gone when the tab closes. "Remember on this device" moves it to
 * localStorage instead; "Forget" removes it from both. A key is never written
 * anywhere else — not into a saved graph, the autosave, an export or the
 * console — and a test checks that (tests/browser/assistant.spec.js).
 *
 * With the "server" transport there is no key here at all: the local server
 * holds its own (docs/decisions/0009-ai-relay.md).
 */

const PREFIX = "geomarmot:ai-key:";

function store(kind) {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // storage switched off: keys then last only as long as the page
  }
}

const memory = new Map();

/** The key for a provider, or "" when none is set. */
export function loadKey(provider) {
  return (
    store("session")?.getItem(PREFIX + provider) ||
    store("local")?.getItem(PREFIX + provider) ||
    memory.get(provider) ||
    ""
  );
}

/** Whether the key for a provider is kept across browser sessions. */
export function isRemembered(provider) {
  return Boolean(store("local")?.getItem(PREFIX + provider));
}

/**
 * Keep a key, in this tab only unless `remember` is set.
 * @param {string} provider
 * @param {string} key
 * @param {{ remember?: boolean }} [options]
 */
export function saveKey(provider, key, { remember = false } = {}) {
  forgetKey(provider);
  const trimmed = key.trim();
  if (!trimmed) return;
  const target = store(remember ? "local" : "session");
  if (target) target.setItem(PREFIX + provider, trimmed);
  else memory.set(provider, trimmed);
}

/** Remove a provider's key from everywhere it could be kept. */
export function forgetKey(provider) {
  store("session")?.removeItem(PREFIX + provider);
  store("local")?.removeItem(PREFIX + provider);
  memory.delete(provider);
}

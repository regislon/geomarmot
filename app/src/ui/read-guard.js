/*
 * Keeping a read on the generation it started with.
 *
 * UI code that queries compiled views wraps the query in guardedRead(): the
 * generation the UI is showing is retained for the duration, so a recompile
 * that lands mid-read cannot drop the views under it (docs/transformer-api.md,
 * "Generations"). The compile loop plugs the retaining function in at boot; with
 * nothing plugged in (a test page), reads simply run.
 */

let retainCurrent = null;

/** @param {() => () => void} fn returns a release function */
export function setReadGuard(fn) {
  retainCurrent = fn;
}

/** @template T @param {() => Promise<T>} read @returns {Promise<T>} */
export async function guardedRead(read) {
  const release = retainCurrent ? retainCurrent() : () => {};
  try {
    return await read();
  } finally {
    release();
  }
}

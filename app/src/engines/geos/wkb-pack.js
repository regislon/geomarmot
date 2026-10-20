// @ts-check
/* WKB pieces <-> one transferable buffer plus offsets, for messages between the page and the worker. */

/**
 * Concatenate WKB pieces into one buffer.
 * @param {Uint8Array[]} pieces
 */
export function pack(pieces) {
  const offsets = new Uint32Array(pieces.length + 1);
  pieces.forEach((p, i) => (offsets[i + 1] = offsets[i] + p.length));
  const out = new Uint8Array(offsets[pieces.length]);
  pieces.forEach((p, i) => out.set(p, offsets[i]));
  return { buffer: out.buffer, offsets };
}

/**
 * Split one buffer into its WKB pieces (views, no copy).
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 */
export function unpack(bytes, offsets) {
  return Array.from({ length: offsets.length - 1 }, (_, i) => bytes.subarray(offsets[i], offsets[i + 1]));
}

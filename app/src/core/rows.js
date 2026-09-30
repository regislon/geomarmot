// @ts-check
/* Turning Arrow results into plain row objects. */

/**
 * Arrow hands back proxies, BigInts and nested structs. Flatten to plain JS so
 * the rest of the app can treat a row as an ordinary object.
 */
export function normalize(value) {
  if (value == null) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return normalize(value.toJSON());
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value[Symbol.iterator] === "function") return Array.from(value, normalize);
    const out = {};
    for (const key in value) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Rebuild a DECIMAL from the little-endian 32-bit words Arrow hands back.
 *
 * Arrow carries a decimal as its unscaled 128-bit integer, and the scale lives
 * in the schema rather than on the value — so `toJSON()` produces the unscaled
 * digits and 1.50 arrives as "150". Anything wide enough to matter here is
 * beyond a double anyway; a Number is what the grid and the map can use.
 */
function decodeDecimal(words, scale) {
  if (words == null) return null;
  let magnitude = 0n;
  for (let i = words.length - 1; i >= 0; i--) magnitude = (magnitude << 32n) | BigInt(words[i]);
  const bits = BigInt(words.length * 32);
  // Two's complement: the top bit set means the value is negative.
  const signed = magnitude >= 1n << (bits - 1n) ? magnitude - (1n << bits) : magnitude;
  return Number(signed) / 10 ** scale;
}

/** Scale by column name for the decimal fields of a result, or null if none. */
function decimalScales(schema) {
  const scales = new Map();
  for (const field of schema.fields) {
    // Only Decimal carries a numeric `scale`; Timestamp has `unit` instead.
    if (typeof field.type?.scale === "number") scales.set(field.name, field.type.scale);
  }
  return scales.size ? scales : null;
}

/** Plain rows from an Arrow table or record batch. */
export function rowsOf(result) {
  const scales = decimalScales(result.schema);
  return result.toArray().map((row) => {
    const plain = normalize(row.toJSON());
    // Read the decimals off the Arrow row, where the words are still intact.
    if (scales) for (const [name, scale] of scales) plain[name] = decodeDecimal(row[name], scale);
    return plain;
  });
}

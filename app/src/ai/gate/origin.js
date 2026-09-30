// @ts-check
/*
 * Where a param value came from, and redacting what came from data.
 *
 * At level 3 the assistant sees sample rows, and it can copy a value it saw
 * into a param: a customer's name into a Tester condition. When the level is
 * later lowered, that value must not be sent back. So every value the
 * assistant writes is recorded in `node.paramOrigin`:
 *
 *   { "<path>": { by: "ai", level: <L>, hash: "<hash of the value>" } }
 *
 * keyed by the leaf's path ("conditions[0].value"), where L is the highest
 * level the conversation had reached. A value the user typed has no entry.
 *
 * Redaction matches by hash, not by path: when the user deletes row 0, row 1's
 * AI-written value moves to [0] and must still be recognised. A leaf the user
 * changes no longer matches any recorded hash and is sent as theirs. Two kinds
 * of leaf are never redacted, because they cannot carry data: a value from a
 * fixed list (an operator, a mode) and a column name the model is shown at
 * level 1 anyway.
 */

/** Every primitive leaf of a value, with its path. */
export function leaves(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  return value === undefined ? [] : [{ path, value }];
}

/** A short, stable hash of a leaf value (FNV-1a, 2×32 bits). Collisions only ever over-redact. */
export function hashValue(value) {
  const text = `${typeof value}:${String(value)}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Record that the assistant wrote these params, at this conversation level.
 * Entries for leaves it did not write are left as they are.
 * @param {{ paramOrigin?: Record<string, any> }} node
 * @param {Record<string, any>} written  the params the assistant set (not the merged defaults)
 * @param {number} level
 */
export function recordAiParams(node, written, level) {
  const origin = { ...(node.paramOrigin || {}) };
  for (const leaf of leaves(written)) {
    if (leaf.value === null || typeof leaf.value === "boolean" || leaf.value === "") continue;
    origin[leaf.path] = { by: "ai", level, hash: hashValue(leaf.value) };
  }
  node.paramOrigin = origin;
  return node;
}

/** The paths whose leaf values are fixed-list values (enums) in a params schema. */
function enumLeaf(schema, path, root) {
  let node = schema;
  for (const part of path
    .replace(/\[\d+\]/g, ".[]")
    .split(".")
    .filter(Boolean)) {
    if (node?.$ref) node = root.$defs?.[node.$ref.split("/").pop()];
    if (part === "[]") node = node?.items;
    else node = node?.properties?.[part];
    if (!node) return false;
  }
  if (node?.$ref) node = root.$defs?.[node.$ref.split("/").pop()];
  return Array.isArray(node?.enum);
}

/**
 * A copy of a node's params with every assistant-written value from above
 * `level` replaced by a redaction marker.
 * @param {{ params: Record<string, any>, paramOrigin?: Record<string, any> }} node
 * @param {number} level
 * @param {{ schema?: object, knownColumns?: Set<string> }} [options]
 */
export function redactParams(node, level, { schema, knownColumns = new Set() } = {}) {
  const above = new Set(
    Object.values(node.paramOrigin || {})
      .filter((entry) => entry?.by === "ai" && entry.level > level)
      .map((entry) => entry.hash),
  );
  const params = structuredClone(node.params || {});
  if (!above.size) return params;
  const replace = (value, path) => {
    if (Array.isArray(value)) return value.map((item, index) => replace(item, `${path}[${index}]`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replace(item, path ? `${path}.${key}` : key)]),
      );
    if (value === undefined || value === null || typeof value === "boolean") return value;
    if (!above.has(hashValue(value))) return value;
    if (typeof value === "string" && knownColumns.has(value)) return value;
    if (schema && enumLeaf(schema, path, schema)) return value;
    return { redacted: "derived from data above the current level", kind: typeof value };
  };
  return replace(params, "");
}

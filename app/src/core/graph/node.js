/*
 * One node's hooks, in contract order (docs/transformer-api.md):
 * prepare → sql → crs → check. The compiler has already run the SQL guard,
 * resolved the inputs and filled the `needs` fields; it creates the views.
 */

import { MAX_MATERIALISED_CELLS, MAX_OVERLAY_FEATURES } from "../limits.js";

/**
 * @param {any} transformer
 * @param {any} ctx          the context the compiler built; completed here
 * @param {{ prefix: string, owned: {tables: string[]}, outputs: {id: string}[], limits?: any }} env
 * @returns {Promise<{ statements: Record<string, string>, crs: string }>}
 */
export async function runNode(transformer, ctx, { prefix, owned, outputs, limits }) {
  const allocated = new Set();
  let inPrepare = false;
  ctx.tableName = (suffix) => {
    if (!/^[a-z0-9_]+$/i.test(suffix)) throw new Error(`Table suffix "${suffix}" must be letters, digits and _.`);
    const name = `${prefix}_t_${ctx.nodeId}_${suffix}`;
    if (inPrepare) {
      if (!allocated.has(name)) {
        allocated.add(name);
        owned.tables.push(name);
      }
    } else if (!allocated.has(name)) {
      throw new Error(`${ctx.nodeType}: table "${suffix}" was not allocated in prepare().`);
    }
    return name;
  };
  // Legacy prepare steps name their own tables; the adapter reports them here.
  ctx.adoptTable = (name) => {
    if (!owned.tables.includes(name)) owned.tables.push(name);
  };
  ctx.limits = limits || { overlayFeatures: MAX_OVERLAY_FEATURES, materialisedCells: MAX_MATERIALISED_CELLS };

  if (transformer.prepare) {
    inPrepare = true;
    try {
      await transformer.prepare(ctx);
    } finally {
      inPrepare = false;
    }
  }
  const statements = transformer.sql(ctx);
  const expected = outputs.map((port) => port.id).sort();
  const got = Object.keys(statements || {}).sort();
  if (expected.join() !== got.join()) {
    throw new Error(
      `${ctx.nodeType}: sql() returned ports [${got.join(", ")}], its outputs are [${expected.join(", ")}].`,
    );
  }
  const crs = transformer.crs ? transformer.crs(ctx) : ctx.incomingCrs;
  if (transformer.check) await transformer.check(ctx);
  return { statements, crs };
}

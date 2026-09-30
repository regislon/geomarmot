/*
 * Temporary: present a pre-kit registry entry through the new contract, so the
 * compiler only knows one shape while transformers move into their folders one
 * group at a time. Removed when transformers/legacy.js is empty (see docs/debt.md).
 *
 * Old hooks were `sql(node, upstream, ctx)`, `crs(node, incoming)`,
 * `check(node, upstream, ctx)` and `prepare(node, upstream, ctx)`, with
 * `ctx.crs` meaning the incoming CRS. Old prepare steps name their tables after
 * the node id, so the adapter hands them a node whose id carries the compile's
 * namespace and generation: two generations can then never share a table.
 */

import { defineTransformer, API_VERSION } from "./define.js";

function legacyNode(ctx) {
  return { id: ctx.legacyNodeId, type: ctx.nodeType, params: ctx.params };
}

function legacyCtx(ctx) {
  return { schemas: ctx.schemas, rowCount: ctx.rowCount, source: ctx.source, crs: ctx.incomingCrs };
}

export function adaptLegacy(type, entry) {
  const outputs = entry.outputs;
  return defineTransformer({
    apiVersion: API_VERSION,
    id: type,
    name: entry.label || type,
    group: entry.group,
    role: entry.outputs && entry.outputs({ params: {} }).length === 0 && entry.inputs.length ? "sink" : "transform",
    summary: entry.hint || type,
    inputs: entry.inputs,
    outputs: (params) => outputs({ params }),
    // `when(node)` and `options(node, context)` keep their node argument: the inspector passes the node.
    params: entry.params,
    needs: {
      schema: Boolean(entry.needsSchema),
      rowCount: Boolean(entry.needsRowCount),
      lonLat: Boolean(entry.needsLonLat),
    },
    sql: entry.sql ? (ctx) => entry.sql(legacyNode(ctx), ctx.inputs, legacyCtx(ctx)) : undefined,
    crs: entry.crs ? (ctx) => entry.crs(legacyNode(ctx), ctx.incomingCrs) : undefined,
    check: entry.check ? (ctx) => entry.check(legacyNode(ctx), ctx.inputs, legacyCtx(ctx)) : undefined,
    prepare: entry.prepare
      ? async (ctx) => {
          const prepared = await entry.prepare(legacyNode(ctx), ctx.inputs, legacyCtx(ctx));
          for (const table of prepared?.tables || []) ctx.adoptTable(table);
        }
      : undefined,
    write: entry.write,
    action: entry.action,
    help: entry.help,
  });
}

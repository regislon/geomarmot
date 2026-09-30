// @ts-check
/*
 * Shared by the H3 transformers: which parent cell and child resolution a
 * dense positional tile has, how to sample it, and building a hexagon table.
 */

import { qid } from "../../app/src/core/duck.js";
import {
  MAX_MATERIALISED_CELLS,
  ROW_NUMBER_COLUMN,
  childResolutionFor,
  createCellGeometryTable,
  parseParentCell,
  positionalIndexExpr,
} from "../../app/src/engines/h3/index.js";

/** The parent cell: what the user typed, else the one the upstream file is named after. */
export function resolveParent(ctx) {
  const typed = (ctx.params.parent || "").trim();
  if (typed) {
    const parsed = parseParentCell(typed);
    if (!parsed) throw new Error(`"${typed}" is not a valid H3 cell.`);
    return parsed;
  }
  const fromFile = ctx.source?.h3?.parent || parseParentCell(ctx.source?.name || "");
  if (!fromFile) throw new Error("No parent cell — the file is not named after one, so type it in.");
  return fromFile;
}

/** The child resolution: what the user typed, else the one whose child count equals the row count. */
export function resolveChildResolution(ctx, parent) {
  const typed = (ctx.params.resolution || "").trim();
  if (typed) {
    const value = Number(typed);
    if (!Number.isInteger(value) || value < 0 || value > 15)
      throw new Error(`"${typed}" is not an H3 resolution (0-15).`);
    return value;
  }
  const derived = childResolutionFor(parent, ctx.rowCount ?? 0);
  if (derived === null) {
    throw new Error(
      `${(ctx.rowCount ?? 0).toLocaleString()} rows is not a whole number of children of ${parent} — set the child resolution by hand.`,
    );
  }
  return derived;
}

/** The positional index expression for this node's rows. */
export function positionalExprFor(ctx, qualifier = "") {
  const parent = resolveParent(ctx);
  const resolution = resolveChildResolution(ctx, parent);
  const rowRef = qualifier ? `${qualifier}.${qid(ROW_NUMBER_COLUMN)}` : qid(ROW_NUMBER_COLUMN);
  return positionalIndexExpr(parent, resolution, rowRef);
}

/** How many cells Auto aims to build: well above the map's default draw, well under the ceiling. */
const AUTO_SAMPLE_TARGET = 50_000;

export const SAMPLE_STEPS = ["Auto", "All", "10", "100", "1000", "10000"];

/** Take every Nth cell: what the user chose, or enough to keep Auto comfortable. */
export function sampleStep(ctx) {
  const chosen = ctx.params.sample || "Auto";
  if (chosen === "All") return 1;
  if (chosen !== "Auto") return Math.max(1, Number(chosen) || 1);
  const rows = ctx.rowCount ?? 0;
  if (rows <= AUTO_SAMPLE_TARGET) return 1;
  const needed = Math.ceil(rows / AUTO_SAMPLE_TARGET);
  return [10, 100, 1000, 10_000, 100_000].find((step) => step >= needed) || 1_000_000;
}

/** The sampling filter, used identically when collecting cells and when joining back. */
export function sampleWhere(step, expression) {
  return step <= 1 ? "" : ` WHERE ${expression} % ${step} = 0`;
}

/** Materialise the hexagons a geometry node needs, into ctx.tableName("cells"). */
export async function buildCellTable(ctx, selectSql) {
  const rows = await ctx.engine.query(`${selectSql} LIMIT ${MAX_MATERIALISED_CELLS + 1}`);
  if (rows.length > MAX_MATERIALISED_CELLS) {
    throw new Error(`${MAX_MATERIALISED_CELLS.toLocaleString()} cells is the ceiling. Sample, or filter upstream.`);
  }
  await createCellGeometryTable(rows.map((row) => row.cell).filter(Boolean), ctx.tableName("cells"), {
    signal: ctx.signal,
    engine: ctx.engine,
  });
}

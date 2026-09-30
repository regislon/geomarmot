// @ts-check
/*
 * The JavaScript geometry engines for prepare steps. SQL goes through ctx.engine —
 * never the main engine directly — so the same hook runs in an isolated preview
 * engine too (docs/transformer-api.md).
 */

export { createFaceTable, createShapeTable, MAX_OVERLAY_FEATURES } from "../../app/src/engines/jsts.js";
export {
  FILL_MODES,
  H3_INDEX_COLUMN,
  MAX_MATERIALISED_CELLS,
  ROW_NUMBER_COLUMN,
  childResolutionFor,
  createCellGeometryTable,
  createPolygonFillTable,
  parseParentCell,
  positionalIndexExpr,
} from "../../app/src/engines/h3/index.js";

/** Stop a prepare step between batches when its compile has been superseded. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("The compile was superseded.", "AbortError");
}

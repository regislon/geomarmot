// @ts-check
/* Default ceilings for materialising prepare steps (docs/engines.md). Previews pass lower ones. */

/**
 * Input features an overlay accepts. GEOS overlays in background workers, so this guards memory, not the
 * page's responsiveness: each worker's WebAssembly heap is 32-bit (4 GB at most), and the faces are
 * materialised in DuckDB. 200,000 sparse polygons overlay in seconds; dense or very detailed inputs
 * reach the memory limits sooner, and say so.
 */
export const MAX_OVERLAY_FEATURES = 200_000;

/** H3 cells a prepare step may materialise. */
export const MAX_MATERIALISED_CELLS = 2_000_000;

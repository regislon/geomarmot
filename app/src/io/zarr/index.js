/*
 * Zarr stores, read as tables of cells.
 *
 * A Zarr store is not a file. It is a folder of compressed chunks plus a little
 * JSON describing how they fit together, so nothing in the rest of this app
 * applies to it: there is no footer to read, no single object to register with
 * DuckDB, and nothing to drop onto the page. What there is instead is an
 * n-dimensional array — `(year, y, x)` in a typical raster store — and a
 * grid geo-reference hidden in its attributes.
 *
 * So the reader's job is a translation: pick one array, pin every dimension
 * that is not spatial, sample the spatial ones, and hand DuckDB one row per
 * cell with real coordinates on it. From there a Zarr layer is an ordinary
 * table with a geometry column and behaves like every other source.
 *
 * Two things about the I/O are worth knowing before reading further, because
 * the whole plan/estimate machinery below exists because of them.
 *
 *   1. The chunk is the unit of transfer. Sampling every 100th cell of a window
 *      still downloads every chunk that window touches — a stride buys rows,
 *      never bytes. Narrowing the window is the only thing that buys bytes.
 *   2. The arrays are big. A global population grid is 1.44M x 528k cells; one cell per
 *      row would be 760 billion rows. Nothing here is allowed to start a read
 *      without first saying how much it will cost.
 *
 * zarrita does the format work — v2 and v3, consolidated metadata, sharding —
 * and reaches numcodecs for blosc/zstd chunks. Both are loaded lazily, so a
 * session that never opens a Zarr never pays for them.
 */

export { DEFAULT_CELL_BUDGET, defaultPlan, planRefusal, planStats, resolveGeoreference } from "./plan.js";
export { isZarrPath, isZarrStore, openZarrStore } from "./metadata.js";
export { dropTable, materialize, setProgressReporter } from "./flatten.js";

# 0010 — AreaOnAreaOverlayer runs on GEOS (WebAssembly) in workers, not on JSTS

**Status:** accepted

## Context

AreaOnAreaOverlayer used JSTS 2.12.1 on the page's main thread: the boundaries of every polygon were
unioned one after another, the result polygonized, and each face's covering polygons found through
`getInteriorPoint()`. Three problems:

- **Speed.** The one-by-one union slows down sharply as polygons are added. At the 20,000-feature
  cap, 20,000 small sparse boxes had not finished after 20 minutes. A real pair of boundary layers
  (1,028 features, 2.1 million vertices) had unioned 400 boundaries after 11 minutes.
- **Correctness.** An interior point carries no clearance check. On a sliver between two nearly
  coincident boundaries, the point can fall on the wrong side, and the face is assigned to the wrong
  polygon without any warning.
- **Engine.** JSTS has no OverlayNG and no snap-rounding noder, so its results cannot match an engine
  that has them.

## Findings (spike: parity and benchmark)

- **The package.** `geos-wasm` 3.1.1 bundles GEOS 3.13.0 as one ES module (~2.6 MB, WebAssembly
  inlined). Vite emits it as a separate worker chunk, and nothing comes from a CDN.
- **Parity.** On eight partition cases (holes, nesting, coincident and shared edges, multipart,
  random boxes), the worker gives the expected faces and covering sets: symmetric difference
  ≤ 1e-12, in Node and in Chromium (`tests/engines/geos-core.test.js`,
  `tests/browser/geos-overlay.spec.js`).
- **Memory.** The WebAssembly heap stays flat over 20 repeated overlays.
- **Speed in Chromium** (`tests/browser/geos-overlay.bench.spec.js`, one worker):

  | Workload | Faces | Time |
  |---|---:|---:|
  | 20,000 sparse boxes | 21,912 | 0.45 s |
  | 2,000 heavily overlapping boxes | 109,469 | 2.1 s |
  | Real boundary pair (1,028 features, 2.1M vertices) | 53,591 | 36.7 s |

  The real pair's heap peaks at 1.35 GB. A native GEOS build is 1.3–1.6× faster on the same input,
  with identical face counts.

## Decision

- **Engine.** The overlay runs on GEOS in module workers (`app/src/engines/geos/`). JSTS keeps the
  per-feature shapes it was already doing.
- **Workers.** Parts are clustered by envelope proximity. A part alone in its cluster is its own face,
  and the rest are batched into tasks for a pool of up to four workers. A worker whose heap passes
  1.5 GB is replaced. Cancel terminates every worker.
- **Interior points** are certified to lie more than `tau` (extent × 1e-9) from the face boundary.
  The order is point on surface, then the widest constrained-Delaunay incentre, then the maximum
  inscribed circle. A face where no such point exists is **ambiguous**: it goes to Rejected by
  default, or stops the run with "Fail". It is never guessed.
- **Faces return to DuckDB as hex WKB** (`ST_GeomFromHEXWKB`), not WKT, so coordinates survive
  exactly.
- **The feature cap rises from 20,000 to 200,000** (`app/src/core/limits.js`). It now guards memory,
  not page responsiveness.

## Consequences

- **Bundle.** It adds ~2.6 MB, loaded only when an overlay runs.
- **Behaviour.** An overlay may now leave sliver faces out of Output and list them in Rejected
  (`ambiguous_face`). Before, JSTS assigned them silently. Rejected also receives invalid polygons,
  unless Repair is chosen, plus features without a polygon and, with an ID attribute, missing or
  duplicated IDs.
- **Memory limit.** Each worker has its own 32-bit heap (4 GB at most). Very detailed inputs in one
  cluster hit that limit before the feature cap.

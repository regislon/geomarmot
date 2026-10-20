# Deliberate shortcuts

Every shortcut taken on purpose, with the milestone that removes it. Agents and humans edit this
file directly.

| Shortcut | Why | Cleared in |
|---|---|---|
| JSTS geometry work (bounding boxes and circles, densify, smooth) runs on the main thread | caps and yielding keep the page responsive; not true isolation. The overlay already runs in GEOS workers | M7 |
| The GEOS overlay finds covering polygons by scanning x-sorted interior points per prepared polygon, not with a spatial tree | GEOS's STRtree needs a JS callback through the Wasm function table; the scan is fast enough at the measured sizes | when classification time shows it |
| The GEOS overlay has no per-worker memory budget, only a per-task wall limit and heap-size recycling | a page cannot read a worker's memory; an out-of-memory worker fails the overlay with an error | when a real input hits it |
| The GEOS overlay does not merge identical geometries across features before overlaying | parity and speed held without it | when duplicate-heavy inputs show the cost |
| Overlay faces cross from the workers to DuckDB as hex WKB in JSON files | the Engine interface has no Arrow insert; hex keeps coordinates exact | when the Engine gains an Arrow insert |
| Export Cancel on a query that ignores cancelSent restarts the engine | exports run on the main connection's non-streaming path, so cancelSent rarely reaches them | M7 (stream exports on their own connection) |
| Applied draft nodes are placed right of their upstream, which can be outside the visible canvas while the assistant drawer is open | the canvas has no pan-to-fit yet | M7 (fit view on apply) |
| "Export as folder" exports generated transformers made of SQL steps only | a call step is a node, not code; exporting it needs a composition API in the kit | M7 |
| Generated transformers kept in IndexedDB cannot be deleted from the UI | nothing lists them yet; clearing site data removes them | M7 (manage generated transformers) |


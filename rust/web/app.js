// The GeoMarmot app in the browser: boot DuckDB-Wasm (bridge.js), then the egui app (wasm).
import init, { start_app, open_file_bytes } from "./app-pkg/geomarmot_app.js";
import { boot } from "./bridge.js";

const t0 = performance.now();
await boot();
await init();
await start_app(document.getElementById("app"));
window.__app = { bootMs: Math.round(performance.now() - t0), open: open_file_bytes };

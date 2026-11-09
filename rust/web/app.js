// The GeoMarmot app in the browser: boot DuckDB-Wasm (bridge.js), then the egui app (wasm).
import init, { start_app, open_file_bytes, app_command, app_state } from "./app-pkg/geomarmot_app.js";
import { boot } from "./bridge.js";

const t0 = performance.now();
await boot();
await init();
await start_app(document.getElementById("app"));
window.__app = {
  bootMs: Math.round(performance.now() - t0),
  open: open_file_bytes,
  command: (c) => app_command(JSON.stringify(c)),
  state: () => JSON.parse(app_state() || "{}"),
};

// Spike gate 1 in the browser: the Rust fixture runner (wasm) over DuckDB-Wasm.
import init, { run_fixtures, validate_sql } from "./pkg/geomarmot_web.js";
import { boot } from "./bridge.js";
const report = document.getElementById("report");
// Every transformer's fixtures; the runner keeps the gate-1 folders (the ported transformers).
const docs = Object.entries(
  import.meta.glob("../../transformers/*/tests.json", { eager: true, import: "default" }),
).map(([path, doc]) => [path.split("/").at(-2), JSON.stringify(doc)]);

const t0 = performance.now();
const version = await boot();
await init();
const booted = performance.now();
const result = JSON.parse(await run_fixtures(JSON.stringify(docs)));
const ms = (x) => Math.round(x);
window.__validate = validate_sql;
window.__gate1 = { version, bootMs: ms(booted - t0), runMs: ms(performance.now() - booted), ...result };
report.textContent =
  `DuckDB ${version} (DuckDB-Wasm), boot ${ms(booted - t0)} ms, fixtures ${ms(performance.now() - booted)} ms\n` +
  `${result.passed} passed, ${result.failures.length} failed\n\n${result.failures.join("\n\n")}`;

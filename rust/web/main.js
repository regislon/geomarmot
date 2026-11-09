// Spike gate 1 in the browser: the Rust fixture runner (wasm) over DuckDB-Wasm.
import init, { run_fixtures, validate_sql } from "./pkg/geomarmot_web.js";
import { boot } from "./bridge.js";
import attributeFilter from "../../transformers/attribute-filter/tests.json";
import featureJoiner from "../../transformers/feature-joiner/tests.json";
import dissolver from "../../transformers/dissolver/tests.json";
import reprojector from "../../transformers/reprojector/tests.json";
import bufferer from "../../transformers/bufferer/tests.json";
import overlayer from "../../transformers/area-on-area-overlayer/tests.json";
import boundingCircle from "../../transformers/minimum-bounding-circle/tests.json";
import h3Geometry from "../../transformers/h3-geometry-from-index/tests.json";

const report = document.getElementById("report");
const docs = Object.entries({
  attributeFilter,
  featureJoiner,
  dissolver,
  reprojector,
  bufferer,
  overlayer,
  boundingCircle,
  h3Geometry,
}).map(([name, doc]) => [name, JSON.stringify(doc)]);

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

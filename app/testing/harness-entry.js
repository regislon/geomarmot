/*
 * HarnessApi v1 for the bundle (tests/harness/api.md).
 *
 * Imports the same application modules the production entry uses, so the
 * browser suites exercise the bundled code, workers and extension files.
 * Built only with `vite build --mode test`.
 */

import * as duck from "../src/core/duck.js";
import * as graph from "../src/core/graph.js";
import * as transformers from "../../transformers/legacy.js";
import * as sources from "../src/io/sources.js";
import * as writer from "../src/io/writer.js";
import { createHarness } from "../../tests/harness/pages/harness-core.js";

window.__geomarmotHarness = createHarness({
  duck,
  graph,
  registry: {
    register: (type, transformer) => {
      transformers.TRANSFORMERS[type] = transformer;
    },
    defaultParams: transformers.defaultParams,
  },
  sources,
  writer,
});

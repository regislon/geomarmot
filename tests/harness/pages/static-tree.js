/*
 * HarnessApi v1 for an unbundled app tree, whose modules live under /static/.
 * Used for the original tree (baseline capture) and for the flat clean import,
 * until the Vite build exists; then app/testing/harness-entry.js takes over.
 */

import { createHarness } from "./harness-core.js";

const load = (name) => import(`/static/${name}.js`);

const [duck, graph, transformers, sources, writer] = await Promise.all(
  ["duck", "graph", "transformers", "sources", "writer"].map(load),
);

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

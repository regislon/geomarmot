/*
 * HarnessApi v1 for the bundle (tests/harness/api.md).
 *
 * Imports the same application modules the production entry uses, so the
 * browser suites exercise the bundled code, workers and extension files.
 * Built only with `vite build --mode test`.
 */

import * as duck from "../src/core/duck.js";
import * as graph from "../src/core/graph/index.js";
import { registerForTests } from "../../transformers/index.js";
import { defineTransformer } from "../../transformers/_kit/index.js";
import * as sources from "../src/io/sources.js";
import * as writer from "../src/io/writers/index.js";
import { createHarness } from "../../tests/harness/pages/harness-core.js";
import * as model from "../src/core/graph/model.js";
import { createCompiler, mainCompiler } from "../src/core/graph/index.js";
import * as sqlguard from "../src/core/sqlguard/index.js";
import { REGISTRY, transformerFor } from "../../transformers/index.js";
import { KINDS } from "../../transformers/_kit/index.js";
import * as preview from "../src/ai/preview.js";
import * as draft from "../src/ai/draft.js";
import * as specInstall from "../src/ai/spec/install.js";
import * as specValidate from "../src/ai/spec/validate.js";
import * as intake from "../src/ai/intake.js";

window.__geomarmotHarness = createHarness({
  duck,
  graph,
  registry: { register: registerForTests, define: defineTransformer },
  sources,
  writer,
});

// Internals for the contract, lifecycle and guard suites (test build only).

window.__geomarmotInternals = {
  duck,
  model,
  createCompiler,
  mainCompiler,
  sqlguard,
  defineTransformer,
  registerForTests,
  REGISTRY,
  transformerFor,
  KINDS,
  sources,
  preview,
  draft,
  spec: { ...specInstall, ...specValidate },
  intake,
};

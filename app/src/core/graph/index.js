/*
 * The graph: its model (./model.js) and the main compiler (./compiler.js).
 *
 * The canvas edits `graph`; `mainCompiler` compiles it in the "m" namespace.
 * Draft previews make their own compilers (namespace "d<n>") over a copy, so
 * the two never share a relation.
 */

import { sources } from "../../io/sources.js";
import { createCompiler } from "./compiler.js";
import { graph } from "./model.js";

export * from "./model.js";
export { createCompiler } from "./compiler.js";

export const mainCompiler = createCompiler({ namespace: "m", getGraph: () => graph, getSources: () => sources });

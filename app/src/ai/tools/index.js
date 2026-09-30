// @ts-check
/*
 * The assistant's tools (Mode A). Each returns { type, payload, isError?, local? }:
 * `payload` goes through the privacy gate as `type` before it is sent; `local`
 * is shown in the chat only.
 */

import ask from "./ask.js";
import describe from "./describe.js";
import graph from "./graph.js";
import inspect from "./inspect.js";
import preview from "./preview.js";
import propose from "./propose.js";
import search from "./search.js";
import transformer from "./transformer.js";

export const TOOLS = [search, describe, graph, inspect, propose, transformer, preview, ask];

export const TOOL_SPECS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export function toolNamed(name) {
  return TOOLS.find((tool) => tool.name === name) || null;
}

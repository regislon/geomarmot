// @ts-check
import { inspectNode } from "../context.js";
import { structured } from "../gate/index.js";

export default {
  name: "inspect_node",
  description:
    "One node in detail: its params and state, and for each output port the columns and their types, the row count " +
    "and the CRS. Depending on the data level the user chose, it also gives per-column statistics (level 2) and the " +
    "first rows (level 3). An error comes back as a code with names, never with data values below level 3.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["node"],
    properties: { node: { type: "string", maxLength: 20, description: "The node id, for example n3." } },
  },
  async run({ node }, { world, level }) {
    const payload = await inspectNode(world, node, level);
    if (!payload) return { type: "error", payload: { error: structured("UNKNOWN_NODE", { node }) }, isError: true };
    return { type: "node", payload };
  },
};

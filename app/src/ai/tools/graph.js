// @ts-check
import { summarizeGraph } from "../context.js";

export default {
  name: "get_graph",
  description:
    "The graph as it stands: the loaded sources with their columns, every node with its params, state and output row " +
    "counts, the connections, and any draft nodes not yet applied. Call it again after changes.",
  input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  async run(_input, { world, level }) {
    return { type: "graph", payload: summarizeGraph(world, level) };
  },
};

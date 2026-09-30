// @ts-check
import { catalogue } from "../catalogue.js";
import { structured } from "../gate/index.js";

export default {
  name: "describe_transformer",
  description:
    "Full description of one transformer: what it does, when to use it and when not, its input and output ports, " +
    "and every parameter with its kind, options and default. Read this before proposing a node of that type.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", maxLength: 60, description: "The transformer id, for example VertexCreator." },
    },
  },
  async run({ id }) {
    const entry = catalogue().find((e) => e.id === id && e.aiUsable);
    if (!entry)
      return {
        type: "error",
        payload: { error: structured("UNKNOWN_TRANSFORMER", { transformer: id }) },
        isError: true,
      };
    return { type: "transformer", payload: entry };
  },
};

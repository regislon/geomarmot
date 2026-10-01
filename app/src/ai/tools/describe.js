// @ts-check
import { catalogue } from "../catalogue.js";

export default {
  name: "describe_transformer",
  description:
    "Full descriptions of one or more transformers, in one call: what each does, when to use it and when not, its " +
    "input and output ports, and every parameter with the exact JSON shape of its value, an example, its options and " +
    "default. Read this for every transformer you intend to propose — ask for all of them at once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["ids"],
    properties: {
      ids: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", maxLength: 60 },
        description: 'Transformer ids, for example ["VertexCreator", "CoordinateSystemSetter"].',
      },
    },
  },
  async run({ ids }, { level }) {
    const all = catalogue({ level }).filter((entry) => entry.aiUsable);
    const wanted = [...new Set(ids)];
    const entries = wanted.map((id) => all.find((entry) => entry.id === id)).filter(Boolean);
    const unknown = wanted.filter((id) => !all.some((entry) => entry.id === id));
    return { type: "transformers", payload: { entries, unknown } };
  },
};

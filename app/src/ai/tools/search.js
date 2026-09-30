// @ts-check
import { searchCatalogue } from "../catalogue.js";

export default {
  name: "search_transformers",
  description:
    "Search GeoMarmot's transformers by what they do, in plain words (for example 'points from coordinate columns', " +
    "'remove duplicate rows', 'buffer lines'). Returns id, name, group and a one-line summary for the best matches. " +
    "Use describe_transformer on a result before proposing it.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query", "limit"],
    properties: {
      query: { type: "string", maxLength: 200, description: "What the transformer should do." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "How many results, 1 to 20; 8 is a good default.",
      },
    },
  },
  async run({ query, limit }, { level }) {
    const results = searchCatalogue(query, { limit, level }).map(({ id, name, group, summary }) => ({
      id,
      name,
      group,
      summary,
    }));
    return { type: "search", payload: { results } };
  },
};

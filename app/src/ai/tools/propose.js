// @ts-check
import { draft, setDraft } from "../draft.js";
import { intakeProposal } from "../intake.js";

export default {
  name: "propose_nodes",
  description:
    "Propose new nodes and connections as a draft. Nothing changes in the user's graph until they click Apply, so " +
    "propose a complete, working chain in one call. Each node has a short ref of your choosing (lowercase, like 'pts'), " +
    "its transformer type, and its params as a JSON object string holding only the params you set (the rest keep their " +
    "defaults). Edges join an output port to an input port; ends are refs from this call or ids of existing nodes (n1). " +
    "The whole proposal is refused, with the problems listed, if any part is invalid. Readers and Writers cannot be " +
    "proposed; SQL params may only read the node's input.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["nodes", "edges", "replace_draft"],
    properties: {
      nodes: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "type", "params_json"],
          properties: {
            ref: {
              type: "string",
              maxLength: 31,
              description: "Short lowercase name for this node within the proposal.",
            },
            type: { type: "string", maxLength: 60, description: "Transformer id, for example VertexCreator." },
            params_json: {
              type: "string",
              maxLength: 40000,
              description: 'Params as a JSON object, for example {"crs":"EPSG:2056"}.',
            },
          },
        },
      },
      edges: {
        type: "array",
        maxItems: 60,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from", "fromPort", "to", "toPort"],
          properties: {
            from: { type: "string", maxLength: 31 },
            fromPort: { type: "string", maxLength: 60 },
            to: { type: "string", maxLength: 31 },
            toPort: { type: "string", maxLength: 60 },
          },
        },
      },
      replace_draft: { type: "boolean", description: "True to replace the current draft, false to add to it." },
    },
  },
  async run(input, { world, conversation }) {
    const result = await intakeProposal(input, { graph: world.graph, levelReached: conversation.levelReached });
    if (result.ok) setDraft(result.nodes, result.edges, { replace: input.replace_draft });
    return {
      type: "proposal",
      payload: {
        ok: result.ok,
        nodes: result.nodes.map((n) => n.id),
        edges: result.edges.map((e) => `${e.from}.${e.fromPort}->${e.to}.${e.toPort}`),
        problems: result.problems,
      },
      isError: !result.ok,
      local: { draftNodes: draft.nodes.length },
    };
  },
};

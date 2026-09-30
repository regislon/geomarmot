// @ts-check
import { installCustom } from "../spec/install.js";
import { specSchema } from "../spec/validate.js";

const { type, additionalProperties, required, properties } = specSchema;

export default {
  name: "propose_transformer",
  description:
    "Create a reusable transformer when no built-in one (or chain of them) does the job. Its steps are SQL templates " +
    "or calls to built-in transformers. A template is one SELECT reading only {{inputs.<port>}} and {{steps.<earlier " +
    "step>}}, with values only as {{params.<id>}} (rendered as a quoted identifier, identifier list, number or quoted " +
    "string by the param's kind); no table functions, files or other tables. A call step names a built-in transformer, " +
    'wires its input ports, and gives its params as JSON where a string "{{params.x}}" passes this transformer\'s param ' +
    "x. Once accepted, its id can be used as a node type in propose_nodes. The whole spec is refused, with the problems " +
    "listed, if any part is invalid.",
  input_schema: { type, additionalProperties, required, properties },
  async run(spec, { conversation }) {
    const result = await installCustom(spec, conversation.levelReached);
    return {
      type: "proposal",
      payload: { ok: result.ok, nodes: result.ok ? [spec.id] : [], edges: [], problems: result.problems },
      isError: !result.ok,
    };
  },
};

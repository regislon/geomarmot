// @ts-check
import { hasDraft } from "../draft.js";
import { structured } from "../gate/index.js";
import { previewDraft } from "../preview.js";

export default {
  name: "preview_draft",
  description:
    "Run the current draft on a sample (at most 1,000 rows of each input) in a separate engine, without touching the " +
    "user's graph, and report each draft node's state, output columns and row counts on that sample — plus statistics " +
    "or first rows when the data level allows. Use it to check a proposal works before telling the user it is ready.",
  input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  async run(_input, { world, level }) {
    if (!hasDraft())
      return { type: "error", payload: { error: structured("INVALID_INPUT", { param: "draft" }) }, isError: true };
    return { type: "preview", payload: await previewDraft(world, level) };
  },
};

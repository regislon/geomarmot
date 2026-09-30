// @ts-check
/*
 * The assistant's loop (Mode A): send the conversation, run the tools the
 * model asks for, send their gated results back, until it answers in words or
 * a limit is reached.
 *
 * - Every tool input is validated against the tool's full schema first (strict
 *   tools guarantee the shape, not the limits), and a bad one is answered with
 *   a structured error rather than run.
 * - Every tool result goes through gate() at the current level before it is
 *   added; a payload the gate refuses is replaced by a structured error.
 * - When the model stops without its tools being run (a refusal, max_tokens,
 *   the turn limit), each tool_use is still answered, so the conversation stays
 *   valid for the next message.
 * - A result that arrives after the data level was lowered belongs to a
 *   conversation that no longer exists, and is dropped.
 */

import { validate } from "../core/jsonschema.js";
import { send } from "./provider.js";
import { GateError, errorPayload, gate, structured } from "./gate/index.js";
import { TOOL_SPECS, toolNamed } from "./tools/index.js";

export const MAX_TURNS = 12;

export const SYSTEM_PROMPT = `You help people build data-processing graphs in GeoMarmot, a spatial ETL tool that runs in their browser.

A graph is a set of nodes (transformers) joined output port to input port. Readers bring in the files the user loaded; every other node transforms what flows into it. You cannot add Readers or Writers: the user loads files and chooses exports themselves.

How to work:
- Start from get_graph to see the sources, their columns and the nodes already there.
- Find transformers with search_transformers, then read describe_transformer for each one you intend to use; use only params and ports it lists, and only column names you have seen.
- Build the whole chain in one propose_nodes call. It becomes a draft that the user reviews and applies. Check it with preview_draft, then say what it will do in a sentence or two.
- If a proposal is refused, read the problems, fix them and propose again.
- Use inspect_node to check a node's output columns, row counts or errors. What you can see of the data depends on the data level the user chose; do not ask for more than it shows.
- Ask the user with ask_user only when the request is ambiguous and the data cannot settle it.

SQL params (SQLTransformer, AttributeCreator's SQL mode, SQL value specs) may only read the node's own input, called input; no table functions, no other tables, no files.

Keep replies short and plain. Use the tools rather than describing what you would do.`;

/**
 * Run one user message to completion.
 * @param {import("./conversation.js").Conversation} conversation
 * @param {string} text
 * @param {{ settings: any, key?: string, world: any, askUser: (q: string, c: string[]) => Promise<string>, onUpdate?: () => void, sendFn?: typeof send }} options
 */
export async function runTurn(
  conversation,
  text,
  { settings, key, world, askUser, onUpdate = () => {}, sendFn = send },
) {
  conversation.addUserMessage(text);
  onUpdate();
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { signal, epoch } = conversation.begin();
    let response;
    try {
      response = await sendFn(
        { ...settings, key },
        { system: SYSTEM_PROMPT, messages: conversation.messages, tools: TOOL_SPECS, effort: settings.effort },
        { signal },
      );
    } catch (err) {
      if (!conversation.isCurrent(epoch)) return "superseded";
      if (err.type === "aborted") {
        conversation.note("notice", "Stopped.");
        onUpdate();
        return "stopped";
      }
      conversation.note("error", err.message || String(err));
      onUpdate();
      return "error";
    }
    if (!conversation.isCurrent(epoch)) return "superseded";
    conversation.addAssistantTurn(response.content, response.text);

    const unanswered = () =>
      response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        payload: gate("error", { error: structured("LIMIT_EXCEEDED") }, conversation.level),
        isError: true,
      }));

    if (response.stopReason === "refusal") {
      const category = response.refusal?.category ? ` (${response.refusal.category})` : "";
      conversation.note("error", `The model declined this request${category}.`);
      if (response.toolCalls.length) conversation.addToolResults(unanswered());
      onUpdate();
      return "refusal";
    }
    if (response.stopReason === "max_tokens") {
      conversation.note("error", "The reply was cut off at the length limit.");
      if (response.toolCalls.length) conversation.addToolResults(unanswered());
      onUpdate();
      return "max_tokens";
    }
    if (!response.toolCalls.length) {
      onUpdate();
      return "done";
    }
    onUpdate();

    const results = [];
    for (const call of response.toolCalls) {
      results.push(await runTool(call, { world, conversation, askUser }));
      if (!conversation.isCurrent(epoch)) return "superseded";
    }
    conversation.addToolResults(results);
    onUpdate();
  }
  conversation.note("notice", `Stopped after ${MAX_TURNS} steps; send another message to continue.`);
  onUpdate();
  return "turn_limit";
}

/** Run one tool call and return its gated result. */
async function runTool(call, { world, conversation, askUser }) {
  const level = conversation.level;
  const tool = toolNamed(call.name);
  // Error results are gated like any other: at level 3 an error may carry raw text, and it is cut there.
  const fail = (error, local) => ({
    id: call.id,
    name: call.name,
    payload: gate("error", { error }, level),
    isError: true,
    local,
  });
  if (!tool) return fail(structured("INVALID_INPUT", { param: "tool" }));
  const problems = validate(call.input, tool.input_schema);
  if (problems.length) {
    const param = problems[0].path.replace(/^\$\.?/, "") || undefined;
    return fail(structured("INVALID_INPUT", { param }), problems);
  }
  try {
    const result = await tool.run(call.input, { world, level, conversation, askUser });
    const payload = gate(result.type, result.payload, level);
    return {
      id: call.id,
      name: call.name,
      payload,
      isError: Boolean(result.isError),
      local: result.local ?? result.payload,
    };
  } catch (err) {
    if (err instanceof GateError) {
      console.error(err);
      return fail(structured("UNKNOWN_ERROR"), err.message);
    }
    return fail(errorPayload(err, level), err.message);
  }
}

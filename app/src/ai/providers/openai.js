// @ts-check
/*
 * OpenAI models, through the official SDK (openai), Chat Completions.
 *
 * The neutral conversation is translated both ways: text and tool_use blocks
 * become an assistant message with tool_calls, tool_result blocks become tool
 * messages. Provider-specific blocks from another provider (Claude's thinking)
 * are dropped. Tools are strict functions; strict mode wants every property
 * required, which the assistant's tool schemas already are.
 */

import { ProviderError, toStrictSchema, typeForStatus } from "./common.js";

/** No default: the user names the model they want. */
export const DEFAULT_MODEL = "";

const text = (blocks) =>
  blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

function toOpenAiMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "assistant") {
      const calls = blocks.filter((block) => block.type === "tool_use");
      out.push({
        role: "assistant",
        content: text(blocks) || null,
        ...(calls.length && {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }),
      });
      continue;
    }
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      const content = typeof block.content === "string" ? block.content : text(block.content || []);
      out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
    }
    const said = text(blocks);
    if (said) out.push({ role: "user", content: said });
  }
  return out;
}

/** @param {import("./common.js").NeutralRequest} request */
export function buildRequest({ model, system, messages, tools = [], maxTokens = 16000 }) {
  if (!model) throw new ProviderError("bad_request", "Choose an OpenAI model in the assistant settings.");
  /** @type {Record<string, any>} */
  const body = { model, messages: toOpenAiMessages(system, messages), max_completion_tokens: maxTokens };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toStrictSchema(tool.input_schema),
        strict: true,
      },
    }));
    body.tool_choice = "auto";
  }
  return body;
}

const STOP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** @returns {import("./common.js").NeutralResponse} */
export function parseResponse(completion) {
  const choice = completion.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = { __invalidJson: call.function.arguments };
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const refused = Boolean(message.refusal) || choice.finish_reason === "content_filter";
  return {
    content,
    toolCalls: content.filter((b) => b.type === "tool_use").map(({ id, name, input }) => ({ id, name, input })),
    text: text(content),
    stopReason: refused ? "refusal" : STOP[choice.finish_reason] || "end_turn",
    refusal: refused ? { category: null, explanation: message.refusal || "" } : null,
    usage: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
    model: completion.model || "",
  };
}

export async function sendDirect(body, key, signal) {
  const sdk = await import("openai");
  const OpenAI = sdk.default;
  const client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
  try {
    return await client.chat.completions.create(body, { signal });
  } catch (err) {
    if (err instanceof sdk.APIUserAbortError) throw new ProviderError("aborted", "The request was cancelled.");
    if (err instanceof sdk.APIConnectionError) throw new ProviderError("network", "Could not reach the API.");
    if (err instanceof sdk.APIError) throw new ProviderError(typeForStatus(err.status), err.message, err.status);
    throw err;
  }
}

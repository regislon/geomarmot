// @ts-check
/*
 * OpenAI models, through the official SDK (openai), on the Responses API.
 *
 * The Responses API rather than Chat Completions: current models — the
 * reasoning ones especially — only take function tools there. The neutral
 * conversation is translated both ways: text and tool_use blocks become
 * input messages and function_call items, tool_result blocks become
 * function_call_output items. A reasoning model returns reasoning items, which
 * must go back with the next request when tools are in play; they are kept in
 * the conversation as opaque `openai_item` blocks (encrypted, since nothing is
 * stored on OpenAI's side: `store: false`). Blocks from another provider
 * (Claude's thinking) are dropped. Tools are strict functions; strict mode wants
 * every property required, which the assistant's tool schemas already are.
 */

import { ProviderError, toStrictSchema, typeForStatus } from "./common.js";

/** No default: the settings list the models the key can use. */
export const DEFAULT_MODEL = "";

const text = (blocks) =>
  blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

function toInput(messages) {
  const input = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      if (message.role === "assistant") {
        if (block.type === "openai_item") input.push(block.item);
        else if (block.type === "text" && block.text) input.push({ role: "assistant", content: block.text });
        else if (block.type === "tool_use")
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
      } else if (block.type === "tool_result") {
        const output = typeof block.content === "string" ? block.content : text(block.content || []);
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output });
      } else if (block.type === "text" && block.text) {
        input.push({ role: "user", content: block.text });
      }
    }
  }
  return input;
}

/** @param {import("./common.js").NeutralRequest} request */
export function buildRequest({ model, system, messages, tools = [], maxTokens = 16000 }) {
  if (!model) throw new ProviderError("bad_request", "Choose an OpenAI model in the assistant settings.");
  /** @type {Record<string, any>} */
  const body = {
    model,
    instructions: system,
    input: toInput(messages),
    max_output_tokens: maxTokens,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toStrictSchema(tool.input_schema),
      strict: true,
    }));
    body.tool_choice = "auto";
  }
  return body;
}

/** @returns {import("./common.js").NeutralResponse} */
export function parseResponse(response) {
  const content = [];
  let refusal = null;
  for (const item of response.output || []) {
    if (item.type === "reasoning") content.push({ type: "openai_item", item });
    else if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
        if (part.type === "refusal") refusal = { category: null, explanation: part.refusal || "" };
      }
    } else if (item.type === "function_call") {
      let input;
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        input = { __invalidJson: item.arguments };
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  const toolCalls = content.filter((b) => b.type === "tool_use").map(({ id, name, input }) => ({ id, name, input }));
  const cutOff = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
  const filtered = response.status === "incomplete" && response.incomplete_details?.reason === "content_filter";
  return {
    content,
    toolCalls,
    text: text(content),
    stopReason: refusal || filtered ? "refusal" : cutOff ? "max_tokens" : toolCalls.length ? "tool_use" : "end_turn",
    refusal: refusal || (filtered ? { category: "content_filter", explanation: "" } : null),
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
    model: response.model || "",
  };
}

export async function sendDirect(body, key, signal) {
  const sdk = await import("openai");
  const OpenAI = sdk.default;
  const client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
  try {
    return await client.responses.create(body, { signal });
  } catch (err) {
    if (err instanceof sdk.APIUserAbortError) throw new ProviderError("aborted", "The request was cancelled.");
    if (err instanceof sdk.APIConnectionError) throw new ProviderError("network", "Could not reach the API.");
    if (err instanceof sdk.APIError) throw new ProviderError(typeForStatus(err.status), err.message, err.status);
    throw err;
  }
}

/** Ids that are chat models: GPT and the o-series reasoning models. */
const CHAT = /^(gpt-|o\d|chatgpt-)/;
/** Ids that share the prefix but do something else. */
const NOT_CHAT = /(audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation|dall-e|whisper|codex)/;

/**
 * The chat models this key can use, newest first, asked of the API itself
 * rather than written down here, where the list would go stale.
 */
export async function listModels(key) {
  const sdk = await import("openai");
  const client = new sdk.default({ apiKey: key, dangerouslyAllowBrowser: true });
  const models = [];
  try {
    for await (const model of client.models.list()) models.push(model);
  } catch (err) {
    if (err instanceof sdk.APIError) throw new ProviderError(typeForStatus(err.status), err.message, err.status);
    throw new ProviderError("network", "Could not reach the API to list models.");
  }
  return models
    .filter((model) => CHAT.test(model.id) && !NOT_CHAT.test(model.id))
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map((model) => model.id);
}

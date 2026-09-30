// @ts-check
/*
 * Claude, through the official SDK (@anthropic-ai/sdk).
 *
 * The request is built here once and then either sent from the browser with
 * the user's own key, or handed to the local server, which adds its key and
 * sends it through the Python SDK (server/geomarmot/ai.py). The response is the
 * Messages API's own, parsed here in both cases.
 *
 * - Tools are declared `strict`, and tool_choice stays `auto`: current models
 *   refuse forced tool use, so the system prompt asks for the tool instead.
 * - Adaptive thinking, with the effort set explicitly (Claude Opus 5.5 defaults
 *   to medium). Thinking blocks come back in `content` and are sent back
 *   unchanged: the conversation is only ever appended to.
 * - Server-side fallbacks (`fallbacks: "default"`): when a safety classifier
 *   declines, the API reruns the request on the model it recommends for that
 *   category. A refusal that survives the chain is `stopReason: "refusal"`.
 * - The whole prefix is cached (top-level cache_control): the tools and system
 *   prompt never change within a conversation.
 */

import { ProviderError, toStrictSchema } from "./common.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that take adaptive thinking, effort and server-side fallbacks. */
const isCurrent = (model) => /^claude-(opus|sonnet|fable)-5/.test(model);

/**
 * The Messages API request for a neutral request.
 * @param {import("./common.js").NeutralRequest} request
 */
export function buildRequest({
  model = DEFAULT_MODEL,
  system,
  messages,
  tools = [],
  maxTokens = 16000,
  effort = "high",
}) {
  /** @type {Record<string, any>} */
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    cache_control: { type: "ephemeral" },
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toStrictSchema(tool.input_schema),
      strict: true,
    }));
    body.tool_choice = { type: "auto" };
  }
  if (isCurrent(model)) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort };
    body.betas = [FALLBACK_BETA];
    body.fallbacks = "default";
  }
  return body;
}

/**
 * The neutral response for a Messages API response.
 * @returns {import("./common.js").NeutralResponse}
 */
export function parseResponse(message) {
  const content = message.content || [];
  const refused = message.stop_reason === "refusal";
  return {
    content,
    toolCalls: content.filter((block) => block.type === "tool_use").map(({ id, name, input }) => ({ id, name, input })),
    text: content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    stopReason: message.stop_reason || "end_turn",
    refusal: refused
      ? { category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? "" }
      : null,
    usage: { input: message.usage?.input_tokens ?? 0, output: message.usage?.output_tokens ?? 0 },
    model: message.model || "",
  };
}

/** Send a built request straight to the API with the user's key. */
export async function sendDirect(body, key, signal) {
  const sdk = await import("@anthropic-ai/sdk");
  const Anthropic = sdk.default;
  // The key is the user's own, typed into this page and kept in this browser;
  // there is no server of ours in between to hide it from.
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  try {
    return await client.beta.messages.create(body, { signal });
  } catch (err) {
    throw toProviderError(err, sdk);
  }
}

/** A neutral error for an SDK error; `sdk` is the module, whose named exports are the error classes. */
function toProviderError(err, sdk) {
  if (err instanceof sdk.APIUserAbortError) return new ProviderError("aborted", "The request was cancelled.");
  if (err instanceof sdk.AuthenticationError) return new ProviderError("auth", "The API key was refused.", 401);
  if (err instanceof sdk.PermissionDeniedError) return new ProviderError("permission", err.message, 403);
  if (err instanceof sdk.RateLimitError)
    return new ProviderError("rate_limit", "Rate limited; try again shortly.", 429);
  if (err instanceof sdk.BadRequestError) return new ProviderError("bad_request", err.message, 400);
  if (err instanceof sdk.APIConnectionError) return new ProviderError("network", "Could not reach the API.");
  if (err instanceof sdk.APIError) {
    const status = err.status;
    return new ProviderError(status === 529 ? "overloaded" : "api", err.message, status);
  }
  return err;
}

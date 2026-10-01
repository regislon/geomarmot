import { describe, test, expect, vi, beforeEach } from "vitest";
import * as anthropic from "../../app/src/ai/providers/anthropic.js";
import * as openai from "../../app/src/ai/providers/openai.js";
import { toStrictSchema } from "../../app/src/ai/providers/common.js";
import { send, ProviderError } from "../../app/src/ai/provider.js";

const created = [];
vi.mock("@anthropic-ai/sdk", async (original) => {
  const real = await original();
  class Fake {
    constructor(options) {
      this.options = options;
      this.beta = {
        messages: {
          create: async (body, requestOptions) => {
            created.push({ options, body, requestOptions });
            if (body.model === "boom") throw new real.RateLimitError(429, { type: "error" }, "slow", new Headers());
            return {
              model: body.model,
              content: [{ type: "text", text: "hello" }],
              stop_reason: "end_turn",
              usage: {},
            };
          },
        },
      };
    }
  }
  return { ...real, default: Fake };
});

const TOOL = {
  name: "search_transformers",
  description: "Find transformers.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query", "limit"],
    properties: { query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 20 } },
  },
};
const REQUEST = {
  system: "You build graphs.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [TOOL],
};

beforeEach(() => {
  created.length = 0;
});

describe("toStrictSchema", () => {
  test("drops the keywords strict tools refuse, keeps the rest", () => {
    expect(toStrictSchema(TOOL.input_schema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["query", "limit"],
      properties: { query: { type: "string" }, limit: { type: "integer" } },
    });
  });

  test("an open object is refused", () => {
    expect(() => toStrictSchema({ type: "object", properties: {} })).toThrow(/additionalProperties/);
  });

  test("a property called like a keyword survives", () => {
    const schema = { type: "object", additionalProperties: false, properties: { pattern: { type: "string" } } };
    expect(toStrictSchema(schema).properties.pattern).toEqual({ type: "string" });
  });
});

describe("anthropic adapter", () => {
  test("builds a strict, cached, adaptive request with server-side fallbacks", () => {
    const body = anthropic.buildRequest(REQUEST);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(16000);
    expect(body.tools[0].strict).toBe(true);
    expect(body.tools[0].input_schema.properties.limit).toEqual({ type: "integer" });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  test("Haiku gets no thinking, effort or fallbacks", () => {
    const body = anthropic.buildRequest({ ...REQUEST, model: "claude-haiku-4-5" });
    expect(body.thinking).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
  });

  test("parses tool calls and keeps every block, thinking included, for the history", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "search_transformers", input: { query: "buffer", limit: 3 } },
    ];
    const parsed = anthropic.parseResponse({
      model: "claude-opus-5-5",
      content,
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(parsed.content).toBe(content);
    expect(parsed.toolCalls).toEqual([{ id: "t1", name: "search_transformers", input: { query: "buffer", limit: 3 } }]);
    expect(parsed.text).toBe("Looking.");
    expect(parsed.usage).toEqual({ input: 5, output: 7 });
    expect(parsed.refusal).toBeNull();
  });

  test("a refusal carries its category", () => {
    const parsed = anthropic.parseResponse({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "no" },
    });
    expect(parsed.stopReason).toBe("refusal");
    expect(parsed.refusal).toEqual({ category: "cyber", explanation: "no" });
  });
});

describe("openai adapter", () => {
  test("translates the conversation to Responses API input, keeping reasoning items and dropping thinking", () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
    const body = openai.buildRequest({
      model: "some-model",
      system: "sys",
      tools: [TOOL],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "s" },
            { type: "openai_item", item: reasoning },
            { type: "text", text: "ok" },
            { type: "tool_use", id: "c1", name: "search_transformers", input: { query: "x", limit: 1 } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "[]" }] },
      ],
    });
    expect(body.instructions).toBe("sys");
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      reasoning,
      { role: "assistant", content: "ok" },
      { type: "function_call", call_id: "c1", name: "search_transformers", arguments: '{"query":"x","limit":1}' },
      { type: "function_call_output", call_id: "c1", output: "[]" },
    ]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "search_transformers", strict: true });
    expect(body.tools[0].parameters.properties.limit).toEqual({ type: "integer" });
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("needs a model named", () => {
    expect(() => openai.buildRequest({ ...REQUEST, model: "" })).toThrow(ProviderError);
  });

  test("parses output items: reasoning, text, function calls, refusals, cut-offs", () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
    const parsed = openai.parseResponse({
      model: "m",
      status: "completed",
      output: [
        reasoning,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
        { type: "function_call", call_id: "c", name: "f", arguments: "{bad" },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(parsed.stopReason).toBe("tool_use");
    expect(parsed.content[0]).toEqual({ type: "openai_item", item: reasoning });
    expect(parsed.text).toBe("Looking.");
    expect(parsed.toolCalls[0]).toEqual({ id: "c", name: "f", input: { __invalidJson: "{bad" } });
    expect(parsed.usage).toEqual({ input: 3, output: 4 });
    const refused = openai.parseResponse({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't." }] }],
    });
    expect(refused).toMatchObject({ stopReason: "refusal", refusal: { explanation: "I can't." } });
    const cut = openai.parseResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    });
    expect(cut.stopReason).toBe("max_tokens");
  });

  test("a conversation switched to Claude drops OpenAI's reasoning items", () => {
    const body = anthropic.buildRequest({
      ...REQUEST,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "openai_item", item: { type: "reasoning" } },
            { type: "text", text: "ok" },
          ],
        },
      ],
    });
    expect(body.messages[1].content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("send", () => {
  test("browser transport uses the SDK with the user's key and passes the signal", async () => {
    const controller = new AbortController();
    const reply = await send({ provider: "anthropic", transport: "browser", key: "sk-user" }, REQUEST, {
      signal: controller.signal,
    });
    expect(reply.text).toBe("hello");
    expect(created[0].options).toMatchObject({ apiKey: "sk-user", dangerouslyAllowBrowser: true });
    expect(created[0].requestOptions.signal).toBe(controller.signal);
  });

  test("browser transport without a key refuses before any request", async () => {
    await expect(send({ provider: "anthropic", transport: "browser", key: "" }, REQUEST)).rejects.toMatchObject({
      type: "no_key",
    });
    expect(created).toEqual([]);
  });

  test("SDK errors become neutral errors", async () => {
    await expect(
      send({ provider: "anthropic", transport: "browser", key: "k", model: "boom" }, REQUEST),
    ).rejects.toMatchObject({ type: "rate_limit" });
  });

  test("server transport posts the built request, with no key, and maps errors", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 2)
        return new Response(JSON.stringify({ error: { type: "no_key", message: "unset" } }), { status: 400 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "via server" }], stop_reason: "end_turn" }));
    });
    const reply = await send({ provider: "anthropic", transport: "server", key: "sk-must-not-leave" }, REQUEST);
    expect(reply.text).toBe("via server");
    expect(calls[0].url).toBe("./ai/anthropic");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect(calls[0].init.body).not.toContain("sk-must-not-leave");
    expect(JSON.parse(calls[0].init.body).model).toBe("claude-opus-5-5");
    await expect(send({ provider: "anthropic", transport: "server" }, REQUEST)).rejects.toMatchObject({
      type: "no_key",
      status: 400,
    });
    expect(created).toEqual([]);
  });
});

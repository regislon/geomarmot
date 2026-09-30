// @ts-check
/*
 * What every provider adapter shares: the neutral request and response, the
 * neutral error, and the strict-schema conversion.
 *
 * The neutral conversation is Anthropic-shaped — `{ role, content: [blocks] }`
 * with text, tool_use and tool_result blocks — because it is the richer of the
 * two. The Anthropic adapter passes it through untouched (thinking blocks
 * included, which must go back exactly as they came); the OpenAI adapter
 * translates it both ways.
 *
 * @typedef {{ name: string, description: string, input_schema: object }} ToolSpec
 * @typedef {{ role: "user"|"assistant", content: Array<any> }} Message
 * @typedef {object} NeutralRequest
 * @property {string} model
 * @property {string} system
 * @property {Message[]} messages
 * @property {ToolSpec[]} [tools]
 * @property {number} [maxTokens]
 * @property {"low"|"medium"|"high"|"xhigh"|"max"} [effort]
 *
 * @typedef {object} NeutralResponse
 * @property {Array<any>} content      the assistant turn, to append to the conversation as it is
 * @property {Array<{id: string, name: string, input: any}>} toolCalls
 * @property {string} text
 * @property {string} stopReason       end_turn | tool_use | max_tokens | refusal | pause_turn | …
 * @property {{ category: string|null, explanation: string }|null} refusal
 * @property {{ input: number, output: number }} usage
 * @property {string} model
 */

export class ProviderError extends Error {
  /**
   * @param {string} type  auth | permission | rate_limit | bad_request | overloaded | network | no_key | disabled | aborted | api
   * @param {string} message
   * @param {number} [status]
   */
  constructor(type, message, status) {
    super(message);
    this.name = "ProviderError";
    this.type = type;
    this.status = status;
  }
}

/** A neutral error type for an HTTP status. */
export function typeForStatus(status) {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad_request";
  return "api";
}

/*
 * Strict tool schemas guarantee the call's shape, but support only part of
 * JSON Schema: no numeric or length limits, no complex array constraints, no
 * open objects. Those are removed before sending and still enforced — the
 * assistant's intake validates every call against the full schema.
 */
const UNSUPPORTED = new Set([
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "$comment",
  "default",
  "examples",
]);

/** A copy of a schema with the keywords strict tools do not accept removed. */
export function toStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) continue;
    if (key === "properties" || key === "$defs") {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toStrictSchema(sub)]));
    } else if (key === "enum" || key === "const" || key === "required") {
      out[key] = value;
    } else {
      out[key] = toStrictSchema(value);
    }
  }
  if (out.type === "object" && out.additionalProperties !== false) {
    throw new Error("A strict tool schema needs additionalProperties: false on every object.");
  }
  return out;
}

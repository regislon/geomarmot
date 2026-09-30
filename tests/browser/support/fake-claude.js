/*
 * A fake Messages API for browser tests: answers the SDK's requests from a
 * script and records every request body, so a test can check exactly what
 * left the browser.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

let ids = 0;
export const text = (t) => ({ type: "text", text: t });
export const toolUse = (name, input) => ({ type: "tool_use", id: `toolu_${++ids}`, name, input });

/** A scripted reply: content blocks, and a stop reason worked out from them unless given. */
export const reply = (content, extra = {}) => ({
  id: `msg_${++ids}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 10 },
  ...extra,
});

/**
 * Route api.anthropic.com to the script. Each entry is a reply, or a function
 * of the request body returning one. Returns the recorded requests.
 */
export async function fakeClaude(page, script) {
  const requests = [];
  const queue = [...script];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON();
    requests.push({ url: request.url(), headers: request.headers(), body });
    const next = queue.shift();
    if (!next)
      return route.fulfill({
        status: 500,
        headers: CORS,
        body: JSON.stringify({ type: "error", error: { type: "api_error", message: "script ended" } }),
      });
    const message = typeof next === "function" ? next(body) : next;
    if (message.status)
      return route.fulfill({
        status: message.status,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify(message.body),
      });
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
  });
  return requests;
}

/** Everything the page sent to the provider, as one string. */
export const everythingSent = (requests) =>
  requests.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join("\n");

// @ts-check
/*
 * The local server as transport: the request goes to POST ./ai/<provider>,
 * which adds the key from the server's environment. The page never holds the
 * key, and the session cookie (docs/decisions/0005-proxy-auth.md) is what lets
 * the request through.
 */

import { ProviderError, typeForStatus } from "./common.js";

/** Which providers the server has a key for; all false when there is no server. */
export async function serverProviders() {
  try {
    const response = await fetch("./ai/providers", { credentials: "same-origin" });
    if (!response.ok) return { anthropic: false, openai: false };
    const body = await response.json();
    return { anthropic: body.anthropic === true, openai: body.openai === true };
  } catch {
    return { anthropic: false, openai: false };
  }
}

export async function sendViaServer(provider, body, signal) {
  let response;
  try {
    response = await fetch(`./ai/${encodeURIComponent(provider)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError("aborted", "The request was cancelled.");
    throw new ProviderError("network", `Could not reach the local server: ${err.message}`);
  }
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = reply.error || {};
    throw new ProviderError(
      error.type || typeForStatus(response.status),
      error.message || response.statusText,
      response.status,
    );
  }
  return reply;
}

// @ts-check
/*
 * The one way the assistant talks to a model: send(settings, request).
 *
 * `settings.provider` picks the adapter (anthropic, openai), `settings.transport`
 * picks the route: "browser" sends straight to the provider with the key typed
 * into the settings, "server" goes through the local server, which holds its own
 * key. Every payload reaching here has already been through the privacy gate
 * (ai/gate.js); this module adds nothing but the provider's request shape.
 */

import * as anthropic from "./providers/anthropic.js";
import * as openai from "./providers/openai.js";
import { sendViaServer } from "./providers/local.js";
import { ProviderError } from "./providers/common.js";

export { ProviderError } from "./providers/common.js";

export const ADAPTERS = { anthropic, openai };

/**
 * @param {{ provider: "anthropic"|"openai", transport: "browser"|"server", model?: string, key?: string }} settings
 * @param {import("./providers/common.js").NeutralRequest} request
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import("./providers/common.js").NeutralResponse>}
 */
export async function send(settings, request, { signal } = {}) {
  const adapter = ADAPTERS[settings.provider];
  if (!adapter) throw new ProviderError("bad_request", `Unknown provider ${settings.provider}.`);
  const body = adapter.buildRequest({ ...request, model: settings.model || adapter.DEFAULT_MODEL });
  let native;
  if (settings.transport === "server") {
    native = await sendViaServer(settings.provider, body, signal);
  } else {
    if (!settings.key) throw new ProviderError("no_key", "Add an API key in the assistant settings.");
    native = await adapter.sendDirect(body, settings.key, signal);
  }
  return adapter.parseResponse(native);
}

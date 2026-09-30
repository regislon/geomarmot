# 0009 — How the assistant reaches a model

**Status:** accepted

Each provider adapter (`app/src/ai/providers/anthropic.js`, `openai.js`) builds that provider's own
request and parses its own response. There are two ways to send it:

- **browser**: straight to the provider through its official JavaScript SDK, with a key the user
  typed into the settings. The key never leaves this browser except to the provider.
- **server**: to `POST /ai/<provider>` on the local server, which adds a key from its environment
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and sends the request through the provider's official
  Python SDK. The page never sees that key.

The relay forwards the provider's native request and returns its native response, rather than
translating to and from a neutral format as first planned. Translation then lives in one place,
the browser adapter, instead of being written twice (JavaScript and Python) and drifting. The relay
still limits what it forwards: an allowlist of top-level fields per provider (no `stream`, no extra
headers or options), 2 MB per request, the access guard and session cookie of `/proxy`, and it is
off in a container unless `GEOMARMOT_AI=1`. Errors come back as `{ error: { type, message } }` with
the key scrubbed, and the key is never logged.

For Claude, requests use strict tools with `tool_choice: auto` (current models refuse forced tool
use), adaptive thinking with an explicit effort, prompt caching of the whole prefix, and
server-side refusal fallbacks (`fallbacks: "default"`). The conversation is only ever appended to,
so thinking blocks go back exactly as they came.

No streaming in v0.1.

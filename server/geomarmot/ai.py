"""AI relay: ``POST /ai/{provider}`` and ``GET /ai/providers``.

The browser builds the provider's own request (``app/src/ai/providers/``) and either sends it
straight to the provider with a key the user typed, or here, where the key comes from this
machine's environment (``ANTHROPIC_API_KEY``, ``OPENAI_API_KEY``) and never reaches the page. The
relay adds the key, calls the provider's official SDK and returns the provider's response as JSON.

It is a relay for the app, not a general proxy:

- Behind the access guard like ``/proxy`` and ``/list``: loopback Host, same-origin, session cookie.
- Only an allowlist of top-level request fields is forwarded; ``stream`` and anything else is refused.
- Requests are capped at 2 MB.
- Errors come back as ``{"error": {"type", "message"}}``; the key is scrubbed from every message
  and never logged.
- Inside a container it is off unless ``GEOMARMOT_AI=1``: an image is easy to run with a key in its
  environment and forget about.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("geomarmot.ai")

MAX_BODY_BYTES = 2 * 1024 * 1024
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
ALLOWED_FIELDS = {
    "anthropic": frozenset(
        {
            "model",
            "max_tokens",
            "system",
            "messages",
            "tools",
            "tool_choice",
            "thinking",
            "output_config",
            "cache_control",
            "betas",
            "fallbacks",
        }
    ),
    # The Responses API (client.responses.create): current models take function tools only there.
    "openai": frozenset(
        {
            "model",
            "instructions",
            "input",
            "tools",
            "tool_choice",
            "max_output_tokens",
            "parallel_tool_calls",
            "reasoning",
            "store",
            "include",
        }
    ),
}
REQUIRED_FIELDS = {"anthropic": frozenset({"model", "messages"}), "openai": frozenset({"model", "input"})}


def enabled() -> bool:
    """The relay is on, except in a container that did not ask for it."""
    if os.environ.get("GEOMARMOT_IN_CONTAINER") == "1":
        return os.environ.get("GEOMARMOT_AI") == "1"
    return True


def _key(provider: str) -> str | None:
    return os.environ.get(ENV_KEYS[provider]) or None


def _anthropic(key: str) -> Callable[[dict[str, Any]], Any]:
    import anthropic

    client = anthropic.Anthropic(api_key=key)
    return lambda body: client.beta.messages.create(**body)


def _openai(key: str) -> Callable[[dict[str, Any]], Any]:
    import openai

    client = openai.OpenAI(api_key=key)
    return lambda body: client.responses.create(**body)


DEFAULT_CLIENTS: dict[str, Callable[[str], Callable[[dict[str, Any]], Any]]] = {
    "anthropic": _anthropic,
    "openai": _openai,
}


def _error(status: int, kind: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"type": kind, "message": message}}, status_code=status)


def _classify(exc: Exception) -> tuple[int, str]:
    """Status and neutral error type for a provider SDK exception, without importing either SDK."""
    status = getattr(exc, "status_code", None)
    name = type(exc).__name__
    if name in ("APIConnectionError", "APITimeoutError"):
        return 502, "network"
    if status == 401 or name == "AuthenticationError":
        return 401, "auth"
    if status == 403 or name == "PermissionDeniedError":
        return 403, "permission"
    if status == 429 or name == "RateLimitError":
        return 429, "rate_limit"
    if status in (400, 404, 413, 422):
        return 400, "bad_request"
    if status == 529 or name == "OverloadedError":
        return 503, "overloaded"
    return 502, "api"


def _scrub(message: str, key: str) -> str:
    return message.replace(key, "[redacted]") if key else message


def add_ai_routes(
    app: Any,
    sessions: Any,
    clients: dict[str, Callable[[str], Callable[[dict[str, Any]], Any]]] | None = None,
) -> None:
    """Register the relay on ``app``. ``clients`` replaces the SDK clients, for tests."""
    factories = clients or DEFAULT_CLIENTS

    @app.get("/ai/providers")
    def providers() -> dict[str, bool]:
        on = enabled()
        return {name: on and _key(name) is not None for name in ENV_KEYS}

    @app.post("/ai/{provider}")
    async def relay(provider: str, request: Request) -> JSONResponse:
        if provider not in ENV_KEYS:
            return _error(404, "unknown_provider", f"No provider called {provider!r}.")
        if not enabled():
            return _error(403, "disabled", "The AI relay is off in this container; set GEOMARMOT_AI=1 to enable it.")
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, "too_large", "The request is larger than 2 MB.")
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            return _error(413, "too_large", "The request is larger than 2 MB.")
        try:
            body = json.loads(raw)
        except ValueError:
            return _error(400, "bad_request", "The request is not JSON.")
        if not isinstance(body, dict):
            return _error(400, "bad_request", "The request must be a JSON object.")
        extra = sorted(set(body) - ALLOWED_FIELDS[provider])
        if extra:
            return _error(400, "bad_request", f"Fields not accepted by the relay: {', '.join(extra)}.")
        missing = sorted(REQUIRED_FIELDS[provider] - set(body))
        if missing:
            return _error(400, "bad_request", f"Missing fields: {', '.join(missing)}.")
        key = _key(provider)
        if key is None:
            return _error(400, "no_key", f"{ENV_KEYS[provider]} is not set on the machine running GeoMarmot.")

        import anyio

        def call() -> Any:
            return factories[provider](key)(body)

        try:
            response = await anyio.to_thread.run_sync(call)
        except Exception as exc:  # noqa: BLE001 - every provider failure becomes a neutral error
            status, kind = _classify(exc)
            message = _scrub(str(exc), key)
            logger.warning("AI relay: %s error from %s: %s", kind, provider, message)
            return _error(status, kind, message)
        dumped = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
        # Belt and braces: nothing the provider sends back should contain the key, but check.
        text = json.dumps(dumped)
        if key in text:
            return JSONResponse(json.loads(_scrub(text, key)))
        return JSONResponse(dumped)

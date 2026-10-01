import json
import logging

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from geomarmot.ai import MAX_BODY_BYTES, add_ai_routes
from geomarmot.app import create_app
from geomarmot.guard import Sessions

KEY = "sk-test-secret-key-0123456789"
BODY = {"model": "claude-opus-5-5", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}


class Reply:
    def __init__(self, data):
        self.data = data

    def model_dump(self, mode="json"):
        return self.data


class StatusError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status_code = status


@pytest.fixture
def calls():
    return []


@pytest.fixture
def ai(tmp_path, monkeypatch, calls):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEOMARMOT_IN_CONTAINER", raising=False)
    behaviour = {
        "reply": Reply({"id": "msg_1", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"})
    }

    def factory(key):
        def create(body):
            calls.append((key, body))
            if isinstance(behaviour["reply"], Exception):
                raise behaviour["reply"]
            return behaviour["reply"]

        return create

    clients = {"anthropic": factory, "openai": factory}
    (tmp_path / "index.html").write_text("<!doctype html>")
    app = create_app(
        sessions=Sessions(TOKEN),
        static_dir=tmp_path,
        extra_routes=lambda app, sessions: add_ai_routes(app, sessions, clients=clients),
    )
    client = TestClient(app, base_url="http://127.0.0.1:8765")
    client.behaviour = behaviour
    return client


def with_session(client):
    assert client.post("/session", headers={"X-GeoMarmot-Token": TOKEN}).status_code == 204
    return client


def test_needs_a_session(ai):
    assert ai.post("/ai/anthropic", json=BODY).status_code == 401
    assert ai.get("/ai/providers").status_code == 401


def test_refuses_another_origin_and_a_foreign_host(ai):
    with_session(ai)
    assert ai.post("/ai/anthropic", json=BODY, headers={"Origin": "https://evil.example"}).status_code == 403
    assert ai.post("/ai/anthropic", json=BODY, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert ai.post("/ai/anthropic", json=BODY, headers={"Host": "192.168.1.5:8765"}).status_code == 403


def test_providers_says_which_keys_exist_and_nothing_else(ai):
    with_session(ai)
    assert ai.get("/ai/providers").json() == {"anthropic": True, "openai": False}


def test_relays_with_the_server_key(ai, calls):
    with_session(ai)
    response = ai.post("/ai/anthropic", json=BODY)
    assert response.status_code == 200
    assert response.json()["content"][0]["text"] == "ok"
    assert calls == [(KEY, BODY)]
    assert KEY not in response.text


def test_refuses_fields_outside_the_allowlist(ai, calls):
    with_session(ai)
    for extra in ({"stream": True}, {"api_key": "x"}, {"extra_headers": {"x": "y"}}):
        response = ai.post("/ai/anthropic", json={**BODY, **extra})
        assert response.status_code == 400
        assert response.json()["error"]["type"] == "bad_request"
    assert calls == []


def test_refuses_an_unknown_provider_and_a_missing_key(ai):
    with_session(ai)
    assert ai.post("/ai/other", json=BODY).status_code == 404
    response = ai.post("/ai/openai", json={"model": "m", "input": []})
    assert response.status_code == 400
    assert response.json()["error"]["type"] == "no_key"


def test_refuses_more_than_2_mb(ai, calls):
    with_session(ai)
    big = {**BODY, "system": "x" * (MAX_BODY_BYTES + 1)}
    response = ai.post("/ai/anthropic", content=json.dumps(big), headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert calls == []


@pytest.mark.parametrize(
    ("error", "status", "kind"),
    [
        (StatusError(401, "invalid x-api-key"), 401, "auth"),
        (StatusError(429, "slow down"), 429, "rate_limit"),
        (StatusError(400, "bad"), 400, "bad_request"),
        (StatusError(529, "overloaded"), 503, "overloaded"),
        (RuntimeError("boom"), 502, "api"),
    ],
)
def test_maps_provider_errors(ai, error, status, kind):
    with_session(ai)
    ai.behaviour["reply"] = error
    response = ai.post("/ai/anthropic", json=BODY)
    assert response.status_code == status
    assert response.json()["error"]["type"] == kind


def test_the_key_never_appears_in_an_error_or_the_log(ai, caplog):
    with_session(ai)
    ai.behaviour["reply"] = StatusError(401, f"key {KEY} was refused")
    with caplog.at_level(logging.DEBUG):
        response = ai.post("/ai/anthropic", json=BODY)
    assert KEY not in response.text
    assert "[redacted]" in response.json()["error"]["message"]
    assert KEY not in caplog.text


def test_the_key_is_scrubbed_from_a_reply_that_echoes_it(ai):
    with_session(ai)
    ai.behaviour["reply"] = Reply({"content": [{"type": "text", "text": f"your key is {KEY}"}]})
    response = ai.post("/ai/anthropic", json=BODY)
    assert KEY not in response.text


def test_off_in_a_container_unless_asked(ai, monkeypatch, calls):
    with_session(ai)
    monkeypatch.setenv("GEOMARMOT_IN_CONTAINER", "1")
    monkeypatch.delenv("GEOMARMOT_AI", raising=False)
    assert ai.get("/ai/providers").json() == {"anthropic": False, "openai": False}
    assert ai.post("/ai/anthropic", json=BODY).status_code == 403
    monkeypatch.setenv("GEOMARMOT_AI", "1")
    assert ai.post("/ai/anthropic", json=BODY).status_code == 200


def test_the_real_clients_are_the_official_sdks():
    import anthropic
    import openai

    assert hasattr(anthropic.Anthropic(api_key="x").beta.messages, "create")
    assert hasattr(openai.OpenAI(api_key="x").responses, "create")


def test_openai_requests_are_responses_api_shaped(ai):
    with_session(ai)
    old_style = {"model": "m", "messages": [{"role": "user", "content": "hi"}]}
    assert ai.post("/ai/openai", json=old_style).json()["error"]["type"] == "bad_request"

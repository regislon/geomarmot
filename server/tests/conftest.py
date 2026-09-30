import io
import urllib.error

import pytest
from fastapi.testclient import TestClient

from geomarmot import app as app_module
from geomarmot.app import create_app
from geomarmot.guard import Sessions

TOKEN = "test-launch-token"


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


@pytest.fixture
def upstream(monkeypatch):
    """Record upstream requests; answer with whatever the test puts in `replies`."""
    state = {"requests": [], "replies": []}

    def fake_urlopen(request, timeout=None):
        state["requests"].append(request)
        reply = state["replies"].pop(0) if state["replies"] else FakeResponse(b"")
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(app_module.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(app_module, "access_token", lambda: "adc-token")
    return state


@pytest.fixture
def client(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>GeoMarmot</title>")
    app = create_app(sessions=Sessions(TOKEN), static_dir=tmp_path)
    return TestClient(app, base_url="http://127.0.0.1:8765")


@pytest.fixture
def session(client):
    response = client.post("/session", headers={"X-GeoMarmot-Token": TOKEN})
    assert response.status_code == 204
    return client


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://storage.googleapis.com/x", code, "nope", {}, None)

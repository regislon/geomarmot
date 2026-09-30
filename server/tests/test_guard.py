import pytest

from geomarmot.guard import host_name, is_loopback_origin


@pytest.mark.parametrize(
    ("host", "name"),
    [("127.0.0.1:8765", "127.0.0.1"), ("localhost", "localhost"), ("[::1]:80", "[::1]"), ("LOCALHOST:1", "localhost")],
)
def test_host_name(host, name):
    assert host_name(host) == name


def test_loopback_origins():
    assert is_loopback_origin("http://127.0.0.1:5173")
    assert is_loopback_origin("http://localhost")
    assert is_loopback_origin("http://[::1]:8765")
    assert not is_loopback_origin("https://evil.example")
    assert not is_loopback_origin("null")


def test_static_served_on_loopback(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("host", ["192.168.1.20:8765", "evil.example", "rebind.example:8765", "0.0.0.0:8765"])
def test_foreign_host_refused_everywhere(client, host):
    for path in ("/", "/healthz", "/proxy/gs/b/k", "/list?bucket=b"):
        response = client.get(path, headers={"Host": host})
        assert response.status_code == 403, path
        assert "Remote access is not supported" in response.json()["detail"]


def test_cross_origin_refused(session):
    assert session.get("/healthz", headers={"Origin": "https://evil.example"}).status_code == 403
    assert session.get("/healthz", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert session.get("/healthz", headers={"Sec-Fetch-Site": "same-site"}).status_code == 403
    assert (
        session.get(
            "/healthz", headers={"Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"}
        ).status_code
        == 200
    )


def test_session_requires_the_right_token(client):
    assert client.post("/session").status_code == 401
    assert client.post("/session", headers={"X-GeoMarmot-Token": "wrong"}).status_code == 401
    response = client.post("/session", headers={"X-GeoMarmot-Token": "test-launch-token"})
    assert response.status_code == 204
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie


def test_token_can_open_several_sessions(client):
    first = client.post("/session", headers={"X-GeoMarmot-Token": "test-launch-token"}).cookies["gm_session"]
    second = client.post("/session", headers={"X-GeoMarmot-Token": "test-launch-token"}).cookies["gm_session"]
    assert first != second


def test_api_needs_session(client, upstream):
    assert client.get("/proxy/gs/bucket/key.parquet").status_code == 401
    assert client.get("/list", params={"bucket": "bucket"}).status_code == 401
    client.cookies.set("gm_session", "forged")
    assert client.get("/proxy/gs/bucket/key.parquet").status_code == 401
    assert upstream["requests"] == []


def test_security_headers(client):
    response = client.get("/healthz")
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "access-control-allow-origin" not in response.headers

import json

from conftest import FakeResponse, http_error


def test_range_forwarded_and_headers_passed_back(session, upstream):
    upstream["replies"].append(
        FakeResponse(b"abcd", 206, {"content-range": "bytes 0-3/100", "content-length": "4", "x-goog-hash": "no"})
    )
    response = session.get("/proxy/gs/my-bucket/data/file.parquet", headers={"Range": "bytes=0-3"})
    assert response.status_code == 206
    assert response.content == b"abcd"
    assert response.headers["content-range"] == "bytes 0-3/100"
    assert response.headers["accept-ranges"] == "bytes"
    assert "x-goog-hash" not in response.headers
    sent = upstream["requests"][0]
    assert sent.full_url == "https://storage.googleapis.com/my-bucket/data/file.parquet"
    assert sent.get_header("Range") == "bytes=0-3"
    assert sent.get_header("Authorization") == "Bearer adc-token"


def test_key_is_re_encoded(session, upstream):
    session.get("/proxy/gs/my-bucket/Pipeline%3A%20run%20%231/a%3Fb.parquet")
    assert (
        upstream["requests"][0].full_url
        == "https://storage.googleapis.com/my-bucket/Pipeline%3A%20run%20%231/a%3Fb.parquet"
    )


def test_upstream_host_cannot_change(session, upstream):
    for path in (
        "/proxy/gs/evil.example%2F..%2F/x",
        "/proxy/gs/..%2Fexample.org/x",
        "/proxy/gs/UPPER/x",
        "/proxy/gs/a@b/x",
    ):
        session.get(path)
    assert session.get("/proxy/gs/UPPER/x").status_code == 400
    for request in upstream["requests"]:
        assert request.full_url.startswith("https://storage.googleapis.com/")


def test_upstream_status_passed_through(session, upstream):
    upstream["replies"].append(http_error(403))
    assert session.get("/proxy/gs/my-bucket/secret").status_code == 403


def test_head(session, upstream):
    upstream["replies"].append(FakeResponse(b"", 200, {"content-length": "100"}))
    response = session.head("/proxy/gs/my-bucket/file.parquet")
    assert response.status_code == 200
    assert upstream["requests"][0].get_method() == "HEAD"


def test_list(session, upstream):
    items = [{"name": "a/", "size": "0"}, {"name": "x.parquet", "size": "12"}]
    body = json.dumps({"prefixes": ["a/"], "items": items, "nextPageToken": "t"}).encode()
    upstream["replies"].append(FakeResponse(body))
    page = session.get("/list", params={"bucket": "my-bucket", "prefix": ""}).json()
    assert page == {
        "prefixes": ["a/"],
        "items": [{"name": "x.parquet", "size": 12, "updated": None}],
        "nextPageToken": "t",
    }
    assert "delimiter=%2F" in upstream["requests"][0].full_url


def test_list_refused_bucket_explains(session, upstream):
    upstream["replies"].append(http_error(401))
    response = session.get("/list", params={"bucket": "private-bucket"})
    assert response.status_code == 401
    assert "cannot be listed" in response.json()["detail"]


def test_list_rejects_bad_bucket(session, upstream):
    assert session.get("/list", params={"bucket": "../x"}).status_code == 400
    assert upstream["requests"] == []

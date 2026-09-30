import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hatch_build import FrontendBuildHook  # noqa: E402


def hook(root: Path) -> FrontendBuildHook:
    return FrontendBuildHook(str(root), {}, None, None, str(root / "out"), "wheel")


@pytest.fixture
def checkout(tmp_path):
    repo = tmp_path / "repo"
    server = repo / "server"
    (server / "geomarmot").mkdir(parents=True)
    (repo / "package.json").write_text("{}")
    return repo, server


def test_copies_the_built_app_into_the_package(checkout, monkeypatch):
    monkeypatch.delenv("GEOMARMOT_BUILD_FRONTEND", raising=False)
    repo, server = checkout
    (repo / "dist" / "assets").mkdir(parents=True)
    (repo / "dist" / "index.html").write_text("<!doctype html>")
    (repo / "dist" / "assets" / "main.js").write_text("")
    (server / "geomarmot" / "static").mkdir()
    (server / "geomarmot" / "static" / "stale.js").write_text("")
    hook(server).initialize("standard", {})
    static = server / "geomarmot" / "static"
    assert (static / "index.html").is_file()
    assert (static / "assets" / "main.js").is_file()
    assert not (static / "stale.js").exists()


def test_refuses_a_wheel_without_the_app(checkout, monkeypatch):
    monkeypatch.delenv("GEOMARMOT_BUILD_FRONTEND", raising=False)
    _, server = checkout
    with pytest.raises(RuntimeError, match="npm run build"):
        hook(server).initialize("standard", {})


def test_editable_installs_need_no_app(checkout):
    _, server = checkout
    hook(server).initialize("editable", {})
    assert not (server / "geomarmot" / "static").exists()


def test_an_sdist_keeps_the_app_it_carries(tmp_path):
    server = tmp_path / "geomarmot-0.1.0"
    (server / "geomarmot" / "static").mkdir(parents=True)
    (server / "geomarmot" / "static" / "index.html").write_text("<!doctype html>")
    hook(server).initialize("standard", {})
    assert (server / "geomarmot" / "static" / "index.html").is_file()

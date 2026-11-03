"""Phục vụ tĩnh ``web/dist`` (contract C-B §13)."""

from __future__ import annotations

from pathlib import Path

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.http import HttpError
from sim3d_server.server import App
from tests.helpers import dispatch


def write_dist(data_root: DataPaths) -> Path:
    dist = data_root.web_dist_dir
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    return dist


def test_index_and_asset_are_served(app: App, data_root: DataPaths) -> None:
    write_dist(data_root)
    index = dispatch(app, "GET", "/")
    assert index.status == 200
    assert index.content_type.startswith("text/html")
    assert b"<div id=root>" in index.payload

    asset = dispatch(app, "GET", "/assets/app.js")
    assert asset.status == 200
    assert asset.content_type.startswith("text/javascript")
    assert asset.payload == b"console.log(1)"


def test_extensionless_path_falls_back_to_index(app: App, data_root: DataPaths) -> None:
    dist = write_dist(data_root)
    response = dispatch(app, "GET", "/kich-ban/abc")
    assert response.status == 200
    assert response.payload == (dist / "index.html").read_bytes()


def test_missing_dist_is_404_with_hint(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/")
    assert excinfo.value.status == 404
    assert "npm run build" in excinfo.value.detail


def test_missing_file_with_suffix_is_404(app: App, data_root: DataPaths) -> None:
    write_dist(data_root)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/khong-co.png")
    assert excinfo.value.status == 404


def test_static_traversal_is_404(app: App, data_root: DataPaths) -> None:
    write_dist(data_root)
    (data_root.root.parent / "secret.txt").write_text("bí mật", encoding="utf-8")
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/..%2Fsecret.txt")
    assert excinfo.value.status == 404


def test_api_path_never_falls_back_to_spa(app: App, data_root: DataPaths) -> None:
    write_dist(data_root)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/khong-co")
    assert excinfo.value.status == 404
    assert excinfo.value.error == "not_found"

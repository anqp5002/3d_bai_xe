"""Test server (BE spec §7). P1: health + dispatch; P6: router thật."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from http import HTTPStatus
from pathlib import Path

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.server import (
    App,
    HttpError,
    Request,
    health_handler,
    make_server,
)
from sim3d_server.version import VERSION


@pytest.fixture()
def data_root(tmp_path: Path) -> DataPaths:
    """Thư mục data/ tối thiểu: có lot/ để giống cấu trúc thật."""
    (tmp_path / "lot").mkdir()
    (tmp_path / "templates").mkdir()
    (tmp_path / "runs").mkdir()
    return DataPaths.from_root(tmp_path)


def test_health_handler_shape(data_root: DataPaths) -> None:
    """Trả đúng 3 khoá và version khớp package (BE §3)."""
    response = health_handler(
        Request(method="GET", path="/api/health", query={}), data_root, {}
    )
    assert response.status == HTTPStatus.OK
    assert set(response.body) == {"ok", "version", "ffmpeg"}
    assert response.body["ok"] is True
    assert response.body["version"] == VERSION
    assert isinstance(response.body["ffmpeg"], bool)


def test_dispatch_unknown_route_raises_404(data_root: DataPaths) -> None:
    """Đường dẫn lạ phải báo lỗi rõ ràng, không trả 200 rỗng (R2)."""
    app = App(paths=data_root)
    with pytest.raises(HttpError) as excinfo:
        app.dispatch(Request(method="GET", path="/api/khong-co", query={}))
    assert excinfo.value.status == HTTPStatus.NOT_FOUND
    assert excinfo.value.error == "not_found"


def test_dispatch_lot_without_file_is_404(data_root: DataPaths) -> None:
    """Tuyến ``/api/lot/pucpr`` đã cài thật; chưa có file thì 404 kèm lý do (R2)."""
    app = App(paths=data_root)
    with pytest.raises(HttpError) as excinfo:
        app.dispatch(Request(method="GET", path="/api/lot/pucpr", query={}))
    assert excinfo.value.status == HTTPStatus.NOT_FOUND
    assert "lot_pucpr.json" in excinfo.value.detail


@pytest.fixture()
def live_server(data_root: DataPaths) -> Iterator[str]:
    """Chạy server thật trên cổng trống của 127.0.0.1."""
    server = make_server(data_root, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_http_health(live_server: str) -> None:
    """``GET /api/health`` qua HTTP thật trả JSON ok (Done khi của P1)."""
    with urllib.request.urlopen(f"{live_server}/api/health", timeout=5) as response:
        assert response.status == HTTPStatus.OK
        assert response.headers["Content-Type"].startswith("application/json")
        body = json.loads(response.read().decode("utf-8"))
    assert body["ok"] is True
    assert body["version"] == VERSION
    assert isinstance(body["ffmpeg"], bool)


def test_http_unknown_route_is_json_error(live_server: str) -> None:
    """404 phải là JSON ``{error, detail}`` chứ không phải trang HTML của stdlib."""
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(f"{live_server}/api/khong-co", timeout=5)
    error = excinfo.value
    assert error.code == HTTPStatus.NOT_FOUND
    body = json.loads(error.read().decode("utf-8"))
    assert set(body) == {"error", "detail"}


def test_server_binds_localhost_only(data_root: DataPaths) -> None:
    """BE §1: chỉ nghe 127.0.0.1."""
    server = make_server(data_root, port=0)
    try:
        host, _port = server.server_address[:2]
    finally:
        server.server_close()
    assert host == "127.0.0.1"


def test_data_paths_requires_existing_root(tmp_path: Path) -> None:
    """``--root`` sai là lỗi cấu hình, báo ngay (R2)."""
    with pytest.raises(NotADirectoryError):
        DataPaths.from_root(tmp_path / "khong-ton-tai")

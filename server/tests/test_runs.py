"""Tạo lần xuất, nhận file theo luồng, chặn path traversal (BE §7, contract C-B §7–§9)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

import sim3d_server.runs as runs_module
from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError
from sim3d_server.server import App
from tests.helpers import dispatch, dispatch_json, put_run_file


def create_run(app: App, name: str = "kiem-thu") -> str:
    response = dispatch_json(
        app,
        "POST",
        "/api/runs",
        {"name": name, "outputs": ["full"], "duration_frames": 5, "fps": 25},
    )
    assert response.status == 200
    return response.body["run_id"]


def make_png(width: int = 640, height: int = 640) -> bytes:
    image = np.full((height, width, 3), 80, dtype=np.uint8)
    ok, buffer = cv2.imencode(".png", image)
    assert ok
    return buffer.tobytes()


def multipart_body(fields: dict[str, str], filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = "----sim3dtestboundary"
    chunks = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        for name, value in fields.items()
    ]
    head = "".join(chunks).encode("utf-8")
    file_head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + file_head + data + tail, f"multipart/form-data; boundary={boundary}"


def test_create_run_makes_folder(app: App, data_root: DataPaths) -> None:
    run_id = create_run(app)
    assert run_id.endswith("_kiem-thu")
    assert (data_root.runs_dir / run_id).is_dir()


def test_duplicate_name_gets_suffix(app: App) -> None:
    first = create_run(app)
    second = create_run(app)
    assert second != first
    assert second.endswith("-2")


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "x", "outputs": [], "duration_frames": 5, "fps": 25},
        {"name": "x", "outputs": ["full"], "duration_frames": 5, "fps": 24},
        {"name": "x" * 41, "outputs": ["full"], "duration_frames": 5, "fps": 25},
        {"name": "x", "outputs": ["full"], "duration_frames": -1, "fps": 25},
        {"name": "x", "outputs": ["full", "cam3"], "duration_frames": 5, "fps": 25},
    ],
)
def test_create_run_validation_is_400(app: App, payload: dict[str, object]) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "POST", "/api/runs", payload)
    assert excinfo.value.status == 400


def test_put_allowed_file_is_written(app: App, data_root: DataPaths) -> None:
    run_id = create_run(app)
    payload = b"frame,S001\r\n0,1\r\n"
    response = put_run_file(app, run_id, "gt_frames.csv", payload, "text/csv")
    assert response.status == 204
    assert (data_root.runs_dir / run_id / "gt_frames.csv").read_bytes() == payload


def test_put_techgar_config_subpath(app: App, data_root: DataPaths) -> None:
    run_id = create_run(app)
    response = put_run_file(
        app,
        run_id,
        "techgar_config/MANIFEST.json",
        b'{"source": "sim3d"}',
        "application/json",
    )
    assert response.status == 204
    assert (data_root.runs_dir / run_id / "techgar_config" / "MANIFEST.json").is_file()


@pytest.mark.parametrize(
    "relative",
    [
        "../secret.json",
        "..%2Fsecret.json",
        "techgar_config/../../secret.json",
        "C:/secret.json",
        "/etc/passwd",
        "techgar_config/settings.json",
        "evil.txt",
    ],
)
def test_put_path_traversal_is_403(app: App, relative: str) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "PUT", f"/api/runs/{run_id}/files/{relative}", b"x", "application/json")
    assert excinfo.value.status == 403
    assert excinfo.value.error == ERROR_NAMES[403]


def test_put_wrong_content_type_is_415(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        put_run_file(app, run_id, "raw_full.mp4", b"x", "text/plain")
    assert excinfo.value.status == 415


def test_put_to_missing_run_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        put_run_file(app, "20260101-000000_khong-co", "gt_frames.csv", b"x", "text/csv")
    assert excinfo.value.status == 404


def test_put_too_large_is_413(
    app: App, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = create_run(app)
    monkeypatch.setitem(runs_module.BODY_LIMITS, ".csv", 4)
    with pytest.raises(HttpError) as excinfo:
        put_run_file(app, run_id, "gt_frames.csv", b"0123456789", "text/csv")
    assert excinfo.value.status == 413


def test_post_frame_writes_png(app: App, data_root: DataPaths) -> None:
    run_id = create_run(app)
    body, content_type = multipart_body({"frame_index": "3"}, "000003.png", make_png())
    response = dispatch(app, "POST", f"/api/runs/{run_id}/frames", body, content_type)
    assert response.status == 204
    written = data_root.runs_dir / run_id / "frames_tmp" / "000003.png"
    assert written.is_file()
    assert written.read_bytes().startswith(b"\x89PNG")


def test_post_frame_bad_index_is_400(app: App) -> None:
    run_id = create_run(app)
    body, content_type = multipart_body({"frame_index": "-1"}, "x.png", make_png())
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", f"/api/runs/{run_id}/frames", body, content_type)
    assert excinfo.value.status == 400


def test_post_frame_not_png_is_400(app: App) -> None:
    run_id = create_run(app)
    body, content_type = multipart_body({"frame_index": "0"}, "000000.png", b"khong-phai-png")
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", f"/api/runs/{run_id}/frames", body, content_type)
    assert excinfo.value.status == 400


def test_post_frame_wrong_content_type_is_415(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", f"/api/runs/{run_id}/frames", b"x", "application/json")
    assert excinfo.value.status == 415


def test_open_folder_missing_run_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", "/api/runs/20260101-000000_khong-co/open-folder")
    assert excinfo.value.status == 404

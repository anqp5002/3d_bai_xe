"""Đường dự phòng PNG → ffmpeg (BE §4.3, §7; D12)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from sim3d_server import media
from sim3d_server.config import DataPaths
from sim3d_server.http import HttpError
from sim3d_server.server import App
from tests.helpers import build_run, dispatch

RUN_ID = "20261031-041500_ffmpeg"


def write_frame(path, index: int) -> None:
    image = np.full((640, 640, 3), index % 200, dtype=np.uint8)
    assert cv2.imwrite(str(path), image)


def test_finalize_reports_missing_frame_without_filling(app: App, data_root: DataPaths) -> None:
    run_dir = build_run(data_root, RUN_ID)
    frames = run_dir / "frames_tmp"
    frames.mkdir()
    write_frame(frames / "000000.png", 0)
    write_frame(frames / "000002.png", 2)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", f"/api/runs/{RUN_ID}/finalize")
    assert excinfo.value.status == 400
    assert "000001" in excinfo.value.detail
    assert (frames / "000000.png").is_file()
    assert (run_dir / "raw_full.mp4").is_file()


@pytest.mark.skipif(
    media.ffmpeg_path() is None,
    reason="máy không có ffmpeg — BE §7 cho phép skip có đánh dấu",
)
def test_finalize_50_png_becomes_50_frames(app: App, data_root: DataPaths) -> None:
    run_dir = build_run(data_root, RUN_ID, frames=50)
    (run_dir / "raw_full.mp4").unlink()
    frames = run_dir / "frames_tmp"
    frames.mkdir()
    for index in range(50):
        write_frame(frames / f"{index:06d}.png", index)

    response = dispatch(app, "POST", f"/api/runs/{RUN_ID}/finalize")
    assert response.status == 200
    assert response.body["ok"] is True, response.body["items"]
    assert not frames.exists()

    capture = cv2.VideoCapture(str(run_dir / "raw_full.mp4"))
    try:
        assert capture.isOpened()
        assert round(float(capture.get(cv2.CAP_PROP_FPS))) == 25
        count = 0
        while True:
            ok, _frame = capture.read()
            if not ok:
                break
            count += 1
    finally:
        capture.release()
    assert count == 50


@pytest.mark.skipif(
    media.ffmpeg_path() is not None,
    reason="máy có ffmpeg — không kiểm được nhánh 503",
)
def test_finalize_without_ffmpeg_is_503(app: App, data_root: DataPaths) -> None:
    run_dir = build_run(data_root, RUN_ID)
    frames = run_dir / "frames_tmp"
    frames.mkdir()
    write_frame(frames / "000000.png", 0)
    write_frame(frames / "000001.png", 1)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", f"/api/runs/{RUN_ID}/finalize")
    assert excinfo.value.status == 503
    assert "ffmpeg" in excinfo.value.detail
    assert "winget install Gyan.FFmpeg" in excinfo.value.detail

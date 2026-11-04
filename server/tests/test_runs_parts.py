"""Ghi video theo khúc tại vị trí (P17n / ANS_34): mediabunny `StreamTarget` -> `PUT .../parts/<offset>/<path>`."""

from __future__ import annotations

import pytest

import sim3d_server.runs as runs_module
from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError
from sim3d_server.server import App
from tests.helpers import dispatch
from tests.test_runs import create_run


def put_part(app: App, run_id: str, offset: int, relative: str, data: bytes):
    return dispatch(app, "PUT", f"/api/runs/{run_id}/parts/{offset}/{relative}", data, "video/mp4")


def commit(app: App, run_id: str, relative: str):
    return dispatch(app, "POST", f"/api/runs/{run_id}/commit/{relative}")


def test_chunks_then_commit_make_the_video(app: App, data_root: DataPaths) -> None:
    run_id = create_run(app)
    run_dir = data_root.runs_dir / run_id
    assert put_part(app, run_id, 0, "raw_full.mp4", b"AAAA").status == 204
    assert put_part(app, run_id, 4, "raw_full.mp4", b"BBBB").status == 204
    # chưa commit: chưa có file thật, chỉ có .part
    assert not (run_dir / "raw_full.mp4").exists()
    assert (run_dir / "raw_full.mp4.part").read_bytes() == b"AAAABBBB"
    assert commit(app, run_id, "raw_full.mp4").status == 204
    assert (run_dir / "raw_full.mp4").read_bytes() == b"AAAABBBB"
    assert not (run_dir / "raw_full.mp4.part").exists()


def test_patching_an_earlier_offset_overwrites_in_place(app: App, data_root: DataPaths) -> None:
    """mediabunny cuối cùng quay lại sửa kích thước mdat ở đầu file."""
    run_id = create_run(app)
    put_part(app, run_id, 0, "raw_cam1.mp4", b"0000000000")
    put_part(app, run_id, 2, "raw_cam1.mp4", b"XY")
    commit(app, run_id, "raw_cam1.mp4")
    assert (data_root.runs_dir / run_id / "raw_cam1.mp4").read_bytes() == b"00XY000000"


def test_offset_beyond_current_size_is_409(app: App) -> None:
    run_id = create_run(app)
    put_part(app, run_id, 0, "raw_full.mp4", b"AAAA")
    with pytest.raises(HttpError) as excinfo:
        put_part(app, run_id, 5, "raw_full.mp4", b"B")
    assert excinfo.value.status == 409


def test_first_chunk_must_start_at_zero(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        put_part(app, run_id, 3, "raw_full.mp4", b"B")
    assert excinfo.value.status == 409


@pytest.mark.parametrize("offset", ["-1", "abc", "1.5"])
def test_bad_offset_is_400(app: App, offset: str) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "PUT", f"/api/runs/{run_id}/parts/{offset}/raw_full.mp4", b"x", "video/mp4")
    assert excinfo.value.status == 400


def test_only_mp4_is_allowed(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "PUT", f"/api/runs/{run_id}/parts/0/gt_frames.csv", b"x", "text/csv")
    assert excinfo.value.status == 400


@pytest.mark.parametrize("relative", ["../x.mp4", "raw_evil.mp4", "techgar_config/../raw_full.mp4"])
def test_path_outside_whitelist_is_403(app: App, relative: str) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        put_part(app, run_id, 0, relative, b"x")
    assert excinfo.value.status == 403
    assert excinfo.value.error == ERROR_NAMES[403]


def test_wrong_content_type_is_415(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "PUT", f"/api/runs/{run_id}/parts/0/raw_full.mp4", b"x", "text/plain")
    assert excinfo.value.status == 415


def test_missing_run_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        put_part(app, "20260101-000000_khong-co", 0, "raw_full.mp4", b"x")
    assert excinfo.value.status == 404


def test_commit_without_chunks_is_404(app: App) -> None:
    run_id = create_run(app)
    with pytest.raises(HttpError) as excinfo:
        commit(app, run_id, "raw_full.mp4")
    assert excinfo.value.status == 404


def test_total_size_over_limit_is_413(app: App, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runs_module.config, "MAX_VIDEO_BYTES", 6)
    run_id = create_run(app)
    put_part(app, run_id, 0, "raw_full.mp4", b"AAAA")
    with pytest.raises(HttpError) as excinfo:
        put_part(app, run_id, 4, "raw_full.mp4", b"BBBB")
    assert excinfo.value.status == 413

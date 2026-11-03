"""``verify.json`` đủ 6 mục, đúng/thiếu frame/thiếu cột (BE §6–§7)."""

from __future__ import annotations

import json

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.http import HttpError
from sim3d_server.server import App
from tests.helpers import build_run, dispatch

RUN_ID = "20261031-041500_kiem-thu"


def finalize(app: App, run_id: str = RUN_ID) -> dict[str, object]:
    response = dispatch(app, "POST", f"/api/runs/{run_id}/finalize")
    assert response.status == 200
    return response.body


def test_verify_ok_when_all_files_valid(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID)
    report = finalize(app)
    assert report["ok"] is True, report["items"]
    assert report["run_id"] == RUN_ID
    assert [item["id"] for item in report["items"]] == [1, 2, 3, 4, 5, 6]
    assert all(item["ok"] for item in report["items"])
    assert report["generated_at"].endswith("Z")
    assert report["export_seconds"] >= 0

    run_dir = data_root.runs_dir / RUN_ID
    for tag in ("0", "mid", "last"):
        assert (run_dir / f"verify_overlay_{tag}.jpg").is_file()
    stored = json.loads((run_dir / "verify.json").read_text(encoding="utf-8"))
    assert stored["ok"] is True


def test_verify_missing_video_frame_is_reported(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID, frames=5, skip_video_frames=4)
    report = finalize(app)
    assert report["ok"] is False
    item = next(entry for entry in report["items"] if entry["id"] == 1)
    assert item["ok"] is False
    assert "4 frame, cần 5" in item["detail"]


def test_verify_accepts_scaled_video_sizes(app: App, data_root: DataPaths) -> None:
    """BRIEF_P15: cỡ cam lấy từ image_size của config, không hằng số.

    Hệ số s=2 ⇒ cam1/cam2 800×1280; ``raw_full`` vẫn 640×640 vì là ảnh toàn
    cảnh cho người xem, không phải đầu vào TechGAR. ``verify`` phải coi là đúng.
    """
    build_run(data_root, RUN_ID, camera_mode="2cam", video_size=(800, 1280))
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 1)
    assert item["ok"] is True, item["detail"]
    assert "800×1280" in item["detail"]


def test_verify_rejects_video_size_mismatch_with_config(app: App, data_root: DataPaths) -> None:
    """Video 400×640 nhưng config khai image_size 800×1280 ⇒ mục 1 phải fail rõ."""

    build_run(data_root, RUN_ID, camera_mode="2cam", video_size=(800, 1280))
    # Ghi đè video thường 400×640 để lệch với config 800×1280.
    from tests.helpers import write_video

    run_dir = data_root.runs_dir / RUN_ID
    write_video(run_dir / "raw_cam1.mp4", 5, (400, 640))
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 1)
    assert item["ok"] is False
    assert "400×640" in item["detail"]
    assert "800×1280" in item["detail"]


def test_verify_missing_slot_column_is_reported(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID, drop_slot_column="S100")
    report = finalize(app)
    assert report["ok"] is False
    item = next(entry for entry in report["items"] if entry["id"] == 2)
    assert item["ok"] is False
    assert "S100" in item["detail"]
    assert "1 cột ô" in item["detail"]


def test_verify_missing_techgar_file_is_reported(app: App, data_root: DataPaths) -> None:
    build_run(
        data_root,
        RUN_ID,
        camera_mode="2cam",
        drop_techgar_file="gate_zones.json",
    )
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 4)
    assert item["ok"] is False
    assert "gate_zones.json" in item["detail"]


def test_verify_1cam_ok_without_techgar(app: App, data_root: DataPaths) -> None:
    """ANS_1 A.1: 1 cam chỉ có raw_full + GT, không techgar_config; mục 4 vẫn ok."""
    build_run(data_root, RUN_ID, camera_mode="1cam", with_techgar=False)
    report = finalize(app)
    assert report["ok"] is True, report["items"]
    item = next(entry for entry in report["items"] if entry["id"] == 4)
    assert item["ok"] is True
    assert "1 cam: không xuất techgar_config (ANS_1 A.1)" in item["detail"]


def test_verify_1cam_missing_full_video_fails(app: App, data_root: DataPaths) -> None:
    """1 cam vẫn phải có raw_full.mp4; thiếu là mục 1 fail."""
    build_run(data_root, RUN_ID, camera_mode="1cam", with_full_video=False)
    report = finalize(app)
    assert report["ok"] is False
    item = next(entry for entry in report["items"] if entry["id"] == 1)
    assert item["ok"] is False
    assert "raw_full.mp4" in item["detail"]


def test_verify_2cam_ok_with_all_videos(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID, camera_mode="2cam")
    report = finalize(app)
    assert report["ok"] is True, report["items"]
    item = next(entry for entry in report["items"] if entry["id"] == 4)
    assert item["ok"] is True
    assert "techgar_config" in item["detail"]


def test_verify_2cam_missing_cam2_fails(app: App, data_root: DataPaths) -> None:
    run_dir = build_run(data_root, RUN_ID, camera_mode="2cam")
    (run_dir / "raw_cam2.mp4").unlink()
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 1)
    assert item["ok"] is False
    assert "raw_cam2.mp4" in item["detail"]


def test_verify_missing_lot_fails_overlay_item(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID, with_lot=False)
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 5)
    assert item["ok"] is False
    assert "lot_pucpr.json" in item["detail"]


def test_verify_event_order_is_checked(app: App, data_root: DataPaths) -> None:
    run_dir = build_run(data_root, RUN_ID)
    (run_dir / "gt_events.csv").write_text(
        "car,slot,gate_in_frame,parked_frame,depart_frame,"
        "cam2_to_cam1_overlap_enter,gate_out_frame,arrival_crosses_cameras,"
        "initial_parked,model,color,speed_kmh\n"
        "V001,S001,1,4,2,3,5,0,0,sedan,white,10\n",
        encoding="utf-8",
    )
    report = finalize(app)
    item = next(entry for entry in report["items"] if entry["id"] == 3)
    assert item["ok"] is False
    assert "parked_frame=4 > depart_frame=2" in item["detail"]


def test_finalize_missing_run_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "POST", "/api/runs/20260101-000000_khong-co/finalize")
    assert excinfo.value.status == 404


def test_run_detail_and_list_expose_verify(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID)
    finalize(app)

    detail = dispatch(app, "GET", f"/api/runs/{RUN_ID}")
    assert detail.status == 200
    assert detail.body["run_id"] == RUN_ID
    assert detail.body["created_at"].endswith("Z")
    assert "verify.json" in detail.body["files"]
    assert "techgar_config/MANIFEST.json" in detail.body["files"]
    assert detail.body["verify"]["ok"] is True

    listing = dispatch(app, "GET", "/api/runs")
    assert listing.status == 200
    assert [entry["run_id"] for entry in listing.body] == [RUN_ID]
    assert listing.body[0]["verify"]["ok"] is True


def test_run_detail_missing_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/runs/20260101-000000_khong-co")
    assert excinfo.value.status == 404


def test_run_detail_before_finalize_has_null_verify(app: App, data_root: DataPaths) -> None:
    build_run(data_root, RUN_ID)
    detail = dispatch(app, "GET", f"/api/runs/{RUN_ID}")
    assert detail.body["verify"] is None

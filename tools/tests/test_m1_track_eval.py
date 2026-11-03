"""Test cho ``sim3d/tools/m1_track_eval.py`` trên dữ liệu tổng hợp nhỏ (P15b)."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import m1_eval
import m1_track_eval

CAMS = ("cam1", "cam2")


def _write_run(
    tmp_path: Path,
    *,
    gt: dict[str, dict[int, tuple[float, float, str]]],
    events: list[dict[str, object]] | None = None,
    predictions: list[dict[str, object]] | None = None,
    image_size: tuple[int, int] = (400, 640),
    mask_polygon: list[dict[str, float]] | None = None,
    manifest: dict[str, object] | None = None,
    name: str = "run",
) -> Path:
    """Run tổng hợp: gt_frames.csv có cột xe, mask, MANIFEST, predictions."""
    run = tmp_path / name
    (run / "m1" / "session").mkdir(parents=True)
    (run / "techgar_config").mkdir(parents=True)

    cars = sorted(gt)
    frames = sorted({frame for per_car in gt.values() for frame in per_car})
    header = ["frame"]
    for car in cars:
        header.extend([f"{car}_u", f"{car}_v", f"{car}_cams"])
    with (run / "gt_frames.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for frame in frames:
            row: list[object] = [frame]
            for car in cars:
                point = gt[car].get(frame)
                row.extend(["", "", ""] if point is None else [point[0], point[1], point[2]])
            writer.writerow(row)

    if events is not None:
        fields = [
            "car",
            "slot",
            "gate_in_frame",
            "parked_frame",
            "depart_frame",
            "cam2_to_cam1_overlap_enter",
            "gate_out_frame",
            "arrival_crosses_cameras",
            "initial_parked",
            "model",
            "color",
            "speed_kmh",
        ]
        with (run / "gt_events.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, restval="")
            writer.writeheader()
            for event in events:
                writer.writerow(event)

    width, height = image_size
    polygon = mask_polygon or [
        {"x": 0.0, "y": 0.0},
        {"x": float(width), "y": 0.0},
        {"x": float(width), "y": float(height)},
        {"x": 0.0, "y": float(height)},
    ]
    for cam in CAMS:
        (run / "techgar_config" / f"roi_mask_{cam}.json").write_text(
            json.dumps({"polygon": polygon, "image_size": [width, height]}),
            encoding="utf-8",
        )

    payload = {"image_size": [width, height]}
    if manifest:
        payload.update(manifest)
    (run / "techgar_config" / "MANIFEST.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )

    with (run / "m1" / "session" / "predictions.jsonl").open("w", encoding="utf-8") as handle:
        for record in predictions or []:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return run


def _obs(
    *,
    cam: str = "cam1",
    x: float,
    y: float,
    gid: str | None = None,
    local: int | None = 1,
    velocity: tuple[float, float] = (1.0, 0.0),
    kind: str = "detection",
) -> dict[str, object]:
    return {
        "camera_id": cam,
        "observation_kind": kind,
        "anchor_pixel": {"x": x, "y": y, "reference": "tracker_center"},
        "velocity_px_per_frame": list(velocity),
        "canonical_gid": gid,
        "local_track_id": local,
    }


def _pred(frame: int, observations: list[dict[str, object]]) -> dict[str, object]:
    """``frame`` là frame GT 0-based; predictions dùng ``frame_idx`` 1-based."""
    return {"frame_idx": frame + 1, "observations": observations}


# ---------------------------------------------------------------------------------------
# Recall xe-frame (giữ định nghĩa recall_probe)
# ---------------------------------------------------------------------------------------
def test_frame_recall_dem_xe_frame_dang_chay(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(4)}},
        predictions=[
            _pred(1, [_obs(x=110, y=200)]),
            # Observation đứng yên không được tính là "đang chuyển động".
            _pred(2, [_obs(x=120, y=200, velocity=(0.0, 0.0))]),
        ],
    )

    result = m1_track_eval.evaluate_run(run)

    cam1 = result["frame_recall"]["cam1"]
    assert cam1["gt_moving_frames"] == 3, "3 frame sau đều dịch chuyển > 0,3 px"
    assert cam1["detected_moving_frames"] == 1
    assert cam1["detected_ratio"] == pytest.approx(1 / 3)
    assert cam1["gid_frames"] == 0
    assert result["frame_recall"]["cam2"]["gt_moving_frames"] == 0


def test_frame_recall_khong_tinh_xe_vang_mat_roi_hien_lai(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={
            "V001": {
                0: (100.0, 200.0, "cam1"),
                3: (200.0, 200.0, "cam1"),  # vắng frame 1-2 rồi hiện lại chỗ khác
            }
        },
        predictions=[],
    )

    result = m1_track_eval.evaluate_run(run)

    assert result["frame_recall"]["cam1"]["gt_moving_frames"] == 0


# ---------------------------------------------------------------------------------------
# Đo theo xe: GID, đứt track
# ---------------------------------------------------------------------------------------
def test_per_car_co_gid_va_dem_dut_track(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(8)}},
        events=[
            {
                "car": "V001",
                "slot": "S001",
                "gate_in_frame": 0,
                "parked_frame": "",
                "depart_frame": "",
                "initial_parked": 0,
            }
        ],
        predictions=[
            _pred(1, [_obs(x=110, y=200, gid="G1", local=7)]),
            _pred(2, [_obs(x=120, y=200, gid="G1", local=7)]),
            # frame 3 mất dấu dù GT vẫn đang chạy trong mask
            _pred(4, [_obs(x=140, y=200, gid="G2", local=8)]),
            # frame 5 đổi local track (đứt track dù vẫn cùng GID)
            _pred(5, [_obs(x=150, y=200, gid="G2", local=9)]),
        ],
    )

    result = m1_track_eval.evaluate_run(run)
    per_car = result["per_car"]
    car = per_car["cars"][0]

    assert per_car["cars_measured"] == 1
    assert car["eligible_frames"] == 8
    assert car["matched_frames"] == 4
    assert car["has_gid"] is True
    assert car["gids"] == ["G1", "G2"]
    assert car["gid_frames"] == 4
    assert car["breaks"] == 2, "1 lần mất dấu (gap) + 1 lần đổi local track/GID"
    assert per_car["cars_with_gid"] == 1
    assert per_car["breaks_total"] == 2


def test_gid_tai_su_dung_cho_nhieu_xe(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={
            "V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(3)},
            "V002": {frame: (100.0 + 10 * frame, 300.0, "cam1") for frame in range(3, 6)},
        },
        events=[
            {"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0},
            {"car": "V002", "slot": "S002", "gate_in_frame": 3, "initial_parked": 0},
        ],
        predictions=[
            _pred(1, [_obs(x=110, y=200, gid="G9", local=1)]),
            _pred(2, [_obs(x=120, y=200, gid="G9", local=1)]),
            _pred(4, [_obs(x=110, y=300, gid="G9", local=1)]),
            _pred(5, [_obs(x=120, y=300, gid="G9", local=1)]),
        ],
    )

    result = m1_track_eval.evaluate_run(run)
    per_car = result["per_car"]

    assert per_car["cars_with_gid"] == 2
    assert per_car["gid_reuse_count"] == 1
    assert per_car["gid_reuse"] == [{"gid": "G9", "cars": ["V001", "V002"]}]


def test_chi_tinh_doan_tuyen_trong_mask(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (300.0 + 10 * frame, 200.0, "cam1") for frame in range(3)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[_pred(1, [_obs(x=310, y=200, gid="G1")])],
        # Mask chỉ phủ góc trên-trái; xe ở (300, 200) nằm ngoài.
        mask_polygon=[
            {"x": 0.0, "y": 0.0},
            {"x": 50.0, "y": 0.0},
            {"x": 50.0, "y": 50.0},
            {"x": 0.0, "y": 50.0},
        ],
    )

    result = m1_track_eval.evaluate_run(run)

    # Recall xe-frame không lọc mask (giữ đúng số director đo).
    assert result["frame_recall"]["cam1"]["gt_moving_frames"] == 2
    # Đo theo xe thì bỏ toàn bộ vì tuyến nằm ngoài mask.
    per_car = result["per_car"]
    assert per_car["cars_total"] == 1
    assert per_car["cars_measured"] == 0
    assert per_car["cars"][0]["eligible_frames"] == 0


def test_xe_do_san_chi_tinh_tu_luc_roi_o(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0, 200.0, "cam1") for frame in range(6)}},
        events=[
            {
                "car": "V001",
                "slot": "S001",
                "gate_in_frame": "",
                "parked_frame": "",
                "depart_frame": 3,
                "initial_parked": 1,
            }
        ],
        predictions=[],
    )

    result = m1_track_eval.evaluate_run(run)

    assert result["per_car"]["cars"][0]["eligible_frames"] == 3, "chỉ frame 3,4,5"


# ---------------------------------------------------------------------------------------
# Hệ số ảnh s = 2 (MANIFEST)
# ---------------------------------------------------------------------------------------
def test_manifest_s2_gt_con_o_co_goc_thi_nhan_doi(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(4)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[_pred(1, [_obs(x=220, y=400, gid="G1")])],
        image_size=(800, 1280),
        manifest={"s": 2},
    )

    result = m1_track_eval.evaluate_run(run)

    assert result["s"] == 2
    assert result["gt_pixel_scale"] == 2
    assert result["per_car"]["cars"][0]["matched_frames"] == 1
    assert result["frame_recall"]["cam1"]["detected_moving_frames"] == 1


def test_manifest_s2_gt_da_nhan_doi_thi_khong_nhan_lan_nua(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (700.0 + 20 * frame, 400.0, "cam1") for frame in range(4)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[_pred(1, [_obs(x=720, y=400, gid="G1")])],
        image_size=(800, 1280),
        manifest={"s": 2},
    )

    result = m1_track_eval.evaluate_run(run)

    assert result["gt_pixel_scale"] == 1
    assert result["per_car"]["cars"][0]["matched_frames"] == 1


def test_gt_scale_ep_bang_co_cli(tmp_path: Path) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(3)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[_pred(1, [_obs(x=220, y=400, gid="G1")])],
        image_size=(800, 1280),
        manifest={"s": 2},
    )

    result = m1_track_eval.evaluate_run(run, gt_scale=2.0)

    assert result["gt_pixel_scale"] == 2
    assert result["per_car"]["cars"][0]["matched_frames"] == 1


# ---------------------------------------------------------------------------------------
# Tích hợp m1_eval + CLI
# ---------------------------------------------------------------------------------------
def test_m1_eval_in_them_muc_track(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(4)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[_pred(1, [_obs(x=110, y=200, gid="G1")])],
    )

    metrics = m1_eval.evaluate(run, "test")
    m1_eval.print_summary(metrics)

    assert metrics["track"]["frame_recall"]["cam1"]["detected_moving_frames"] == 1
    assert metrics["track"]["per_car"]["cars_with_gid"] == 1
    output = capsys.readouterr().out
    assert "Track (m1_track_eval" in output
    assert "xe-frame đang chạy" in output


def test_cli_ghi_json(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run = _write_run(
        tmp_path,
        gt={"V001": {frame: (100.0 + 10 * frame, 200.0, "cam1") for frame in range(3)}},
        events=[{"car": "V001", "slot": "S001", "gate_in_frame": 0, "initial_parked": 0}],
        predictions=[],
    )
    out = tmp_path / "track.json"

    exit_code = m1_track_eval.main([str(run), "--json", str(out)])

    assert exit_code == 0
    stored = json.loads(out.read_text(encoding="utf-8"))
    assert stored["run"] == "run"
    assert "frame_recall" in stored
    assert "Theo xe" in capsys.readouterr().out


def test_cli_thieu_predictions_tra_loi_2(tmp_path: Path) -> None:
    run = _write_run(tmp_path, gt={}, predictions=[])

    exit_code = m1_track_eval.main(
        [str(run), "--predictions", str(tmp_path / "khong-co.jsonl")]
    )

    assert exit_code == 2

"""Test cho ``sim3d/tools/m1_eval.py`` trên dữ liệu tổng hợp nhỏ (không cần runtime)."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import m1_eval  # noqa: E402


def _write_gt_frames(path: Path, rows: dict[int, dict[str, int]]) -> None:
    slots = list(m1_eval.SLOT_IDS)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["frame", *slots])
        for frame in sorted(rows):
            writer.writerow([frame, *(rows[frame].get(slot, 0) for slot in slots)])


def _write_gt_events(path: Path, rows: list[dict[str, object]]) -> None:
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
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, restval="")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _write_predictions(path: Path, frames: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in frames:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _prediction(frame: int, slots: dict[str, bool], *, camera: str = "cam1") -> dict[str, object]:
    return {
        "frame_idx": frame,
        "slots": [
            {"camera_id": camera, "slot_id": slot_id, "occupied": occupied}
            for slot_id, occupied in slots.items()
        ],
    }


def make_run(tmp_path: Path) -> Path:
    """Run tổng hợp 5 frame, 3 ô, có 1 xe vào rồi ra."""
    run = tmp_path / "run"
    (run / "m1" / "session").mkdir(parents=True)
    (run / "techgar_config").mkdir(parents=True)

    _write_gt_frames(
        run / "gt_frames.csv",
        {
            1: {"S001": 0, "S002": 0, "S003": 0},
            2: {"S001": 1, "S002": 0, "S003": 0},
            3: {"S001": 1, "S002": 0, "S003": 0},
            4: {"S001": 0, "S002": 1, "S003": 0},
            5: {"S001": 0, "S002": 1, "S003": 0},
        },
    )
    _write_gt_events(
        run / "gt_events.csv",
        [
            {
                "car": "V001",
                "slot": "S001",
                "gate_in_frame": 1,
                "parked_frame": 2,
                "depart_frame": 3,
                "gate_out_frame": 5,
                "initial_parked": 0,
            },
            {"car": "V002", "slot": "S002", "initial_parked": 1},
        ],
    )
    _write_predictions(
        run / "m1" / "session" / "predictions.jsonl",
        [
            # frame 1: vision chưa xong -> slots rỗng, phải bị loại khỏi mẫu số
            {"frame_idx": 1, "slots": []},
            _prediction(2, {"S001": True, "S002": False, "S003": False}),
            # frame 3: TechGAR báo S001 trống sớm (đúng GT tại frame này) — không lệch
            _prediction(3, {"S001": True, "S002": False, "S003": False}),
            # frame 4: bỏ sót S002 (GT có xe) -> false_free; S003 báo nhầm -> false_occupied
            _prediction(4, {"S001": False, "S002": False, "S003": True}),
            _prediction(5, {"S001": False, "S002": True, "S003": False}),
        ],
    )
    (run / "techgar_config" / "gate_zones.json").write_text("{}", encoding="utf-8")
    return run


# ---------------------------------------------------------------------------------------
# Đọc dữ liệu
# ---------------------------------------------------------------------------------------
def test_read_predictions_gop_or_giua_camera(tmp_path: Path) -> None:
    path = tmp_path / "predictions.jsonl"
    _write_predictions(
        path,
        [
            {
                "frame_idx": 7,
                "slots": [
                    {"camera_id": "cam1", "slot_id": "S001", "occupied": False},
                    {"camera_id": "cam2", "slot_id": "S001", "occupied": True},
                    {"camera_id": "cam1", "slot_id": "S002", "occupied": False},
                    {"camera_id": "cam1", "slot_id": "S999", "occupied": True},
                ],
            }
        ],
    )
    predictions = m1_eval.read_predictions(path)

    assert len(predictions) == 1
    prediction = predictions[0]
    assert prediction.frame == 7
    assert prediction.occupied["S001"] is True, "camera thứ hai báo có xe thì ô phải là có xe"
    assert prediction.occupied["S002"] is False
    assert prediction.seen == {"S001", "S002"}, "ô ngoài S001-S100 phải bị bỏ"


def test_read_predictions_bo_qua_frame_khong_co_vision(tmp_path: Path) -> None:
    path = tmp_path / "predictions.jsonl"
    _write_predictions(path, [{"frame_idx": 1, "slots": []}, _prediction(2, {"S001": True})])

    predictions = m1_eval.read_predictions(path)

    assert [p.frame for p in predictions] == [1, 2]
    assert predictions[0].seen == set()
    assert predictions[0].occupied == {}


def test_read_gt_events_chap_nhan_o_trong(tmp_path: Path) -> None:
    path = tmp_path / "gt_events.csv"
    _write_gt_events(
        path,
        [
            {
                "car": "V001",
                "slot": "S001",
                "gate_in_frame": "10",
                "parked_frame": "20.0",
                "depart_frame": "",
                "gate_out_frame": "",
            }
        ],
    )

    events = m1_eval.read_gt_events(path)

    assert len(events) == 1
    assert events[0].gate_in_frame == 10
    assert events[0].parked_frame == 20, "giá trị '20.0' phải đọc được"
    assert events[0].depart_frame is None
    assert events[0].gate_out_frame is None


# ---------------------------------------------------------------------------------------
# Occupancy
# ---------------------------------------------------------------------------------------
def test_measure_occupancy_bo_frame_chua_co_vision(tmp_path: Path) -> None:
    run = make_run(tmp_path)
    predictions = m1_eval.read_predictions(run / "m1" / "session" / "predictions.jsonl")
    gt_frames = m1_eval.read_gt_frames(run / "gt_frames.csv")

    result = m1_eval.measure_occupancy(predictions, gt_frames)

    # 4 frame có dữ liệu (2,3,4,5) x 3 ô; frame 1 slots rỗng nên không vào mẫu số.
    assert result.total == 12
    assert result.correct == 10
    assert result.accuracy == pytest.approx(10 / 12)
    assert result.false_free == 1, "frame 4 bỏ sót xe ở S002"
    assert result.false_occupied == 1, "frame 4 báo nhầm xe ở S003"
    assert result.mismatches == [
        (4, "S002", 1, 0, "false_free"),
        (4, "S003", 0, 1, "false_occupied"),
    ]


def test_measure_occupancy_tinh_theo_o_khong_co_bao(tmp_path: Path) -> None:
    predictions = [m1_eval.FramePrediction(frame=1, occupied={"S001": True}, seen={"S001"})]
    gt_frames = {1: {"S001": 1, "S002": 1}}

    result = m1_eval.measure_occupancy(predictions, gt_frames)

    assert result.total == 1, "ô S002 không được camera nào báo thì không tính"
    assert result.correct == 1


def test_measure_occupancy_khong_co_du_lieu() -> None:
    result = m1_eval.measure_occupancy([], {})

    assert result.total == 0
    assert result.accuracy == 0.0


# ---------------------------------------------------------------------------------------
# Độ trễ
# ---------------------------------------------------------------------------------------
def test_measure_latency_tinh_dung_park_va_depart(tmp_path: Path) -> None:
    run = make_run(tmp_path)
    predictions = m1_eval.read_predictions(run / "m1" / "session" / "predictions.jsonl")
    events = m1_eval.read_gt_events(run / "gt_events.csv")

    result = m1_eval.measure_latency(predictions, events)

    # S001: TechGAR chuyển occupied ở frame 2, GT parked frame 2 -> trễ 0.
    # S001: TechGAR chuyển trống ở frame 4, GT depart frame 3 -> trễ 1.
    assert result.delays("park") == [0]
    assert result.delays("depart") == [1]
    assert result.missing == 0
    by_kind = {case.kind: case for case in result.cases}
    assert by_kind["park"].slot == "S001"
    assert by_kind["depart"].techgar_frame == 4
    assert by_kind["depart"].early is False


def test_measure_latency_ghi_ca_bao_som(tmp_path: Path) -> None:
    """``gt_frames.csv`` và ``gt_events.csv`` lệch nhau: phải thấy được ca báo sớm."""
    predictions = [
        m1_eval.FramePrediction(frame=90, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=100, occupied={"S001": True}, seen={"S001"}),
        m1_eval.FramePrediction(frame=140, occupied={"S001": True}, seen={"S001"}),
    ]
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=113,
            depart_frame=None,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency(predictions, events)

    assert result.delays("park") == [-13], "báo sớm 13 frame phải ra trễ âm, không phải 0"
    assert result.cases[0].early is True
    assert result.missing == 0


def test_measure_latency_chon_chuyen_trang_thai_gan_moc_nhat() -> None:
    predictions = [
        m1_eval.FramePrediction(frame=10, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=20, occupied={"S001": True}, seen={"S001"}),
        m1_eval.FramePrediction(frame=30, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=40, occupied={"S001": True}, seen={"S001"}),
    ]
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=38,
            depart_frame=None,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency(predictions, events)

    assert result.delays("park") == [2], "phải chọn lần chuyển ở frame 40 (gần 38), không phải 20"


def test_measure_latency_bo_qua_chuyen_ngoai_cua_so() -> None:
    predictions = [
        m1_eval.FramePrediction(frame=1, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=1000, occupied={"S001": True}, seen={"S001"}),
    ]
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=1,
            depart_frame=None,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency(predictions, events, search_window=100)

    assert result.missing == 1
    assert result.delays("park") == []


def test_measure_latency_bo_qua_moc_ngoai_dai_frame() -> None:
    predictions = [
        m1_eval.FramePrediction(frame=10, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=11, occupied={"S001": True}, seen={"S001"}),
    ]
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=500,
            depart_frame=None,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency(predictions, events)

    assert result.cases == []
    assert result.out_of_range == 1


def test_measure_latency_ghi_ca_khong_thay_chuyen_trang_thai() -> None:
    predictions = [
        m1_eval.FramePrediction(frame=1, occupied={"S001": False}, seen={"S001"}),
        m1_eval.FramePrediction(frame=2, occupied={"S001": False}, seen={"S001"}),
    ]
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=1,
            depart_frame=None,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency(predictions, events)

    assert result.missing == 1
    assert result.delays("park") == []
    assert result.cases[0].techgar_frame is None


def test_measure_latency_khong_co_prediction() -> None:
    events = [
        m1_eval.GtEvent(
            car="V001",
            slot="S001",
            gate_in_frame=None,
            parked_frame=5,
            depart_frame=6,
            gate_out_frame=None,
        )
    ]

    result = m1_eval.measure_latency([], events)

    assert result.cases == []
    assert result.missing == 0


def test_measure_latency_vs_frames_dung_hinh_hoc_o(tmp_path: Path) -> None:
    run = make_run(tmp_path)
    predictions = m1_eval.read_predictions(run / "m1" / "session" / "predictions.jsonl")
    gt_frames = m1_eval.read_gt_frames(run / "gt_frames.csv")
    events = m1_eval.read_gt_events(run / "gt_events.csv")

    cases = m1_eval.measure_latency_vs_frames(predictions, gt_frames, events)

    # gt_frames: S001 0->1 ở frame 2, 1->0 ở frame 4. TechGAR khớp đúng cả hai.
    delays = {(case.kind, case.gt_frame): case.delay for case in cases}
    assert delays[("park", 2)] == 0
    assert delays[("depart", 4)] == 0


def test_gt_frame_transitions_lay_dung_moc() -> None:
    gt_frames = {
        1: {"S001": 0},
        2: {"S001": 1},
        3: {"S001": 1},
        4: {"S001": 0},
    }

    transitions = m1_eval.gt_frame_transitions(gt_frames)

    assert transitions["S001"] == [(1, 0), (2, 1), (4, 0)]


def test_stats_trung_vi_chan_le() -> None:
    assert m1_eval._stats([]) == {"count": 0, "median": None, "max": None}
    assert m1_eval._stats([3]) == {"count": 1, "median": 3.0, "max": 3}
    assert m1_eval._stats([1, 5]) == {"count": 2, "median": 3.0, "max": 5}
    assert m1_eval._stats([7, 1, 3]) == {"count": 3, "median": 3.0, "max": 7}


# ---------------------------------------------------------------------------------------
# Tổng hợp và CLI
# ---------------------------------------------------------------------------------------
def test_evaluate_ghi_metrics_va_ca_lech(tmp_path: Path) -> None:
    run = make_run(tmp_path)

    metrics = m1_eval.evaluate(run, "test")

    assert metrics["frames_evaluated"] == 5
    assert metrics["occupancy"]["frame_slot_total"] == 12
    assert metrics["occupancy"]["mismatched_slots"] == ["S002", "S003"]
    assert metrics["mismatch_rows"] == 2
    assert metrics["latency_frames"]["park"]["count"] == 1
    # gt_frames.csv của run tổng hợp cũng đổi trạng thái -> phải có số đo đối chiếu.
    assert metrics["latency_vs_gt_frames"]["reference"] == "gt_frames.csv (hình học ô)"
    assert metrics["latency_vs_gt_frames"]["park"]["count"] == 1
    # 10/12 = 83.3 % < 95 % nên phần này phải báo KHÔNG ĐẠT (dữ liệu cố ý có lệch).
    assert metrics["pass"]["frame_slot_accuracy"] is False
    # Không đo cổng ở script này.
    assert metrics["gate_counting"]["measured_here"] is False

    stored = json.loads((run / "m1" / "metrics.json").read_text(encoding="utf-8"))
    assert stored["occupancy"]["correct"] == 10

    with (run / "m1" / "mismatches.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["frame"], row["slot"], row["kind"]) for row in rows] == [
        ("4", "S002", "false_free"),
        ("4", "S003", "false_occupied"),
    ]

    with (run / "m1" / "latency.csv").open(encoding="utf-8", newline="") as handle:
        latency_rows = list(csv.DictReader(handle))
    assert {row["kind"] for row in latency_rows} == {"park", "depart"}


def test_main_skip_run_in_ra_bang(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run = make_run(tmp_path)

    exit_code = m1_eval.main([str(run), "--skip-run"])

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "frame-ô: 12" in output
    assert "KHÔNG ĐẠT" in output, "10/12 = 83 % phải dưới ngưỡng 95 %"
    assert "KHÔNG đo ở script này" in output


def test_main_thieu_predictions_tra_loi_2(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "m1").mkdir(parents=True)
    _write_gt_frames(run / "gt_frames.csv", {1: {"S001": 0}})
    _write_gt_events(run / "gt_events.csv", [])

    assert m1_eval.main([str(run), "--skip-run"]) == 2


def test_main_run_dir_khong_ton_tai(tmp_path: Path) -> None:
    assert m1_eval.main([str(tmp_path / "khong-co"), "--skip-run"]) == 2


def test_replay_command_dung_co_va_duong_dan(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "techgar_config").mkdir(parents=True)

    command = m1_eval.replay_command(run, api_port=8011)

    assert "--replay-session" in command
    assert command[command.index("--replay-session") + 1] == str(run)
    assert command[command.index("--api-port") + 1] == "8011"
    assert "--no-display" in command
    # Không dùng cờ không tồn tại trong runtime_server.py.
    assert "--cam1-video" not in command
    assert "--cam2-video" not in command
    # Không đo cổng ở script này nên không cần --live-mode.
    assert "--live-mode" not in command

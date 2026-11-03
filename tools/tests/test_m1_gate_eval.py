"""Test ``m1_gate_eval`` (P10c phần A) trên dữ liệu tổng hợp — không cần runtime thật.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import json
from pathlib import Path

import m1_gate_eval as gate
import pytest


# ---------------------------------------------------------------------------------------
# Đọc GT
# ---------------------------------------------------------------------------------------
def _write_events(path: Path, rows: list[dict[str, str]]) -> Path:
    columns = [
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
    lines = [",".join(columns)]
    for row in rows:
        lines.append(",".join(row.get(column, "") for column in columns))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_read_gt_gate_cases_bo_dong_khong_qua_cong(tmp_path: Path) -> None:
    path = _write_events(
        tmp_path / "gt_events.csv",
        [
            {"car": "V001", "slot": "S010", "gate_in_frame": "102", "gate_out_frame": "2967"},
            # Xe đỗ sẵn rồi rời: chỉ có gate_out.
            {"car": "V002", "slot": "S029", "gate_out_frame": "900", "initial_parked": "1"},
            # Không vào không ra: không phải ca cổng.
            {"car": "V003", "slot": "S095"},
        ],
    )
    cases = gate.read_gt_gate_cases(path)
    assert [case.car for case in cases] == ["V001", "V002"]
    assert gate.count_gt(cases) == (1, 2)


def test_read_gt_gate_cases_doc_cot_rong_thanh_none(tmp_path: Path) -> None:
    path = _write_events(
        tmp_path / "gt_events.csv",
        [{"car": "V001", "slot": "S010", "gate_in_frame": "  ", "gate_out_frame": ""}],
    )
    assert gate.read_gt_gate_cases(path) == []


def test_read_gt_gate_cases_thieu_file_nem_loi(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        gate.read_gt_gate_cases(tmp_path / "khong-co.csv")


def test_read_gt_gate_cases_gia_tri_rac_nem_loi(tmp_path: Path) -> None:
    path = _write_events(
        tmp_path / "gt_events.csv",
        [{"car": "V001", "slot": "S010", "gate_in_frame": "abc"}],
    )
    # R2: không im lặng bỏ qua dữ liệu hỏng.
    with pytest.raises(ValueError):
        gate.read_gt_gate_cases(path)


# ---------------------------------------------------------------------------------------
# Đọc log controller
# ---------------------------------------------------------------------------------------
def test_parse_controller_log_lay_dung_thu_tu_va_noi_dung() -> None:
    text = "\n".join(
        [
            "[GATE] runtime http://127.0.0.1:8001/api/runtime/snapshot",
            "[SESSION API] http://0.0.0.0:8000",
            "[ENTRY] Global ID #1 -> session abc123",
            "[SESSION WAIT] Cannot park session while exiting the facility",
            "[EXIT] Global ID #1 -> deleted session abc123",
            "[ENTRY] Global ID #2 -> session def456",
        ]
    )
    events = gate.parse_controller_log(text)
    assert [(event.kind, event.global_id, event.session_id) for event in events] == [
        ("gate_in", 1, "abc123"),
        ("gate_out", 1, "abc123"),
        ("gate_in", 2, "def456"),
    ]
    assert [event.line for event in events] == [3, 5, 6]


def test_parse_controller_log_rong() -> None:
    assert gate.parse_controller_log("") == []
    assert gate.parse_controller_log("[GATE] Source unavailable: HTTP Error 503") == []


def test_describe_log_tail_log_sach() -> None:
    tail = gate.describe_log_tail(
        "[GATE] runtime http://127.0.0.1:8001/x\n[ENTRY] Global ID #1 -> session a\n"
    )
    assert tail["kind"] == "none"
    assert tail["has_traceback"] is False


def test_describe_log_tail_connection_reset_la_teardown() -> None:
    """Runtime đóng cổng sau khi replay xong ⇒ log có traceback nhưng không phải lỗi đếm."""
    tail = gate.describe_log_tail(
        "\n".join(
            [
                "[ENTRY] Global ID #1 -> session a",
                "[EXIT] Global ID #1 -> deleted session a",
                "Traceback (most recent call last):",
                '  File "gate_session_controller.py", line 899, in main',
                "ConnectionResetError: [WinError 10054] An existing connection was forcibly closed",
            ]
        )
    )
    assert tail["kind"] == "teardown"
    assert tail["has_traceback"] is True
    assert tail["connection_errors"] == 1


def test_describe_log_tail_loi_khac_la_unexpected() -> None:
    tail = gate.describe_log_tail(
        "Traceback (most recent call last):\nKeyError: 'gate_zones'\n"
    )
    assert tail["kind"] == "unexpected"


# ---------------------------------------------------------------------------------------
# Ghép frame từ poll
# ---------------------------------------------------------------------------------------
def _poll(frame: int, sessions: list[dict[str, object]]) -> dict[str, object]:
    return {"t": 0.0, "frame": frame, "sessions": sessions}


def test_attach_frames_vao_la_lan_dau_thay_ra_la_lan_cuoi_thay() -> None:
    polls = [
        _poll(10, []),
        _poll(20, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
        _poll(30, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
        _poll(40, [{"sessionId": "s2", "globalVehicleId": 2, "parkedSpotId": "S029"}]),
        _poll(50, [{"sessionId": "s2", "globalVehicleId": 2, "parkedSpotId": "S029"}]),
        _poll(60, []),
    ]
    events = [
        gate.ControllerEvent("gate_in", 1, "s1", 3),
        gate.ControllerEvent("gate_in", 2, "s2", 4),
        gate.ControllerEvent("gate_out", 1, "s1", 5),
    ]
    resolved, gid_to_slot = gate.attach_frames(events, polls)
    assert [(event.kind, event.frame) for event in resolved] == [
        ("gate_in", 20),
        ("gate_in", 40),
        ("gate_out", 30),
    ]
    assert gid_to_slot == {1: "S010", 2: "S029"}


def test_attach_frames_session_con_song_thi_ra_de_none() -> None:
    polls = [
        _poll(10, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
        _poll(20, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
    ]
    resolved, _ = gate.attach_frames([gate.ControllerEvent("gate_out", 1, "s1", 2)], polls)
    assert resolved[0].frame == 20  # last_seen, không phải "biến mất"
    assert resolved[0].frame is not None


def test_attach_frames_khong_co_poll_thi_frame_none() -> None:
    resolved, gid_to_slot = gate.attach_frames(
        [gate.ControllerEvent("gate_in", 1, "s1", 1)], []
    )
    assert resolved[0].frame is None
    assert gid_to_slot == {}


# ---------------------------------------------------------------------------------------
# So khớp + ca lệch
# ---------------------------------------------------------------------------------------
def _measurement(
    gt_cases: list[gate.GtGateCase],
    events: list[gate.ControllerEvent],
    gid_to_slot: dict[int, str] | None = None,
) -> gate.GateMeasurement:
    return gate.GateMeasurement(
        gt_cases=gt_cases,
        events=events,
        gid_to_slot=dict(gid_to_slot or {}),
    )


def test_build_mismatches_khop_hoan_toan_tra_rong() -> None:
    cases = [
        gate.GtGateCase("V001", "S010", 102, 2967, 0),
        gate.GtGateCase("V002", "S029", 500, None, 0),
    ]
    events = [
        gate.ControllerEvent("gate_in", 7, "a", 1),
        gate.ControllerEvent("gate_out", 7, "a", 2),
        gate.ControllerEvent("gate_in", 8, "b", 3),
    ]
    measurement = _measurement(cases, events, {7: "S010", 8: "S029"})
    assert gate.build_mismatches(measurement) == []


def test_build_mismatches_thieu_luot_vao_cua_gt() -> None:
    cases = [gate.GtGateCase("V001", "S010", 102, None, 0)]
    measurement = _measurement(cases, [], {})
    rows = gate.build_mismatches(measurement)
    assert len(rows) == 1
    assert rows[0]["kind"] == "gate_in"
    assert rows[0]["reason"] == "gt_khong_thay_o_controller"
    assert rows[0]["car"] == "V001"
    assert rows[0]["slot"] == "S010"
    assert rows[0]["gt_frame"] == 102


def test_build_mismatches_controller_dem_them() -> None:
    measurement = _measurement(
        [],
        [gate.ControllerEvent("gate_out", 9, "z", 7, frame=1234)],
        {9: "S077"},
    )
    rows = gate.build_mismatches(measurement)
    assert len(rows) == 1
    assert rows[0]["reason"] == "controller_dem_them"
    assert rows[0]["global_id"] == 9
    assert rows[0]["slot"] == "S077"
    assert rows[0]["controller_frame"] == 1234


def test_build_mismatches_khong_suy_duoc_slot_van_liet_ke() -> None:
    cases = [gate.GtGateCase("V001", "S010", 102, None, 0)]
    measurement = _measurement(cases, [gate.ControllerEvent("gate_in", 3, "a", 1)], {})
    rows = gate.build_mismatches(measurement)
    # Có 1 controller + 1 GT nhưng không nối được slot ⇒ phải báo cả 2 phía, không im lặng.
    reasons = sorted(row["reason"] for row in rows)
    assert reasons == ["controller_dem_them", "gt_khong_thay_o_controller"]


# ---------------------------------------------------------------------------------------
# evaluate() + --skip-run
# ---------------------------------------------------------------------------------------
def test_evaluate_skip_run_doc_lai_log_va_poll(tmp_path: Path) -> None:
    run_dir = tmp_path / "20260101-000000_K8-test"
    work = run_dir / "m1_gate"
    work.mkdir(parents=True)
    _write_events(
        run_dir / "gt_events.csv",
        [
            {"car": "V001", "slot": "S010", "gate_in_frame": "10", "gate_out_frame": "90"},
            {"car": "V002", "slot": "S020"},
        ],
    )
    (work / "gate_log.txt").write_text(
        "\n".join(
            [
                "[GATE] runtime http://127.0.0.1:8001/api/runtime/snapshot",
                "[ENTRY] Global ID #1 -> session s1",
                "[EXIT] Global ID #1 -> deleted session s1",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    with (work / "gate_poll.jsonl").open("w", encoding="utf-8") as handle:
        for frame, sessions in (
            (5, []),
            (12, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
            (80, [{"sessionId": "s1", "globalVehicleId": 1, "parkedSpotId": "S010"}]),
            (95, []),
        ):
            handle.write(
                json.dumps({"t": 0.0, "frame": frame, "sessions": sessions}) + "\n"
            )

    result = gate.evaluate(
        run_dir,
        skip_run=True,
        api_port=8001,
        gate_port=8000,
        poll_interval=0.2,
        timeout_s=10.0,
    )
    assert result["gt"] == {
        "gate_in": 1,
        "gate_out": 1,
        "events": [
            {
                "car": "V001",
                "slot": "S010",
                "gate_in_frame": 10,
                "gate_out_frame": 90,
                "initial_parked": 0,
            }
        ],
    }
    assert result["controller"]["gate_in"] == 1
    assert result["controller"]["gate_out"] == 1
    assert result["pass"]["overall"] is True
    assert result["controller"]["entries"][0]["frame"] == 12
    assert result["controller"]["entries"][0]["slot"] == "S010"
    assert result["controller"]["exits"][0]["frame"] == 80
    assert result["mismatch_count"] == 0

    written = json.loads((work / "gate_result.json").read_text(encoding="utf-8"))
    assert written["pass"]["overall"] is True
    # File ca lệch luôn tồn tại (kể cả khi rỗng) để người đọc biết đã kiểm.
    assert (work / "gate_mismatches.csv").exists()


def test_evaluate_skip_run_lech_thi_ghi_ca_lech(tmp_path: Path) -> None:
    run_dir = tmp_path / "20260101-000000_K2-test"
    work = run_dir / "m1_gate"
    work.mkdir(parents=True)
    _write_events(
        run_dir / "gt_events.csv",
        [{"car": "V001", "slot": "S010", "gate_in_frame": "10", "gate_out_frame": "90"}],
    )
    (work / "gate_log.txt").write_text(
        "[ENTRY] Global ID #1 -> session s1\n", encoding="utf-8"
    )
    (work / "gate_poll.jsonl").write_text("", encoding="utf-8")

    result = gate.evaluate(
        run_dir,
        skip_run=True,
        api_port=8001,
        gate_port=8000,
        poll_interval=0.2,
        timeout_s=10.0,
    )
    assert result["controller"]["gate_in"] == 1
    assert result["controller"]["gate_out"] == 0
    assert result["pass"] == {
        "gate_in": True,
        "gate_out": False,
        "overall": False,
        "threshold": "số lượt khớp GT ±0 (ANS_7)",
    }
    rows = (work / "gate_mismatches.csv").read_text(encoding="utf-8").splitlines()
    assert rows[0] == "kind,reason,car,slot,gt_frame,global_id,controller_frame"
    assert any("gate_out" in row and "gt_khong_thay_o_controller" in row for row in rows)


def test_evaluate_skip_run_thieu_log_nem_loi(tmp_path: Path) -> None:
    run_dir = tmp_path / "20260101-000000_K8-test"
    run_dir.mkdir()
    _write_events(run_dir / "gt_events.csv", [])
    with pytest.raises(FileNotFoundError):
        gate.evaluate(
            run_dir,
            skip_run=True,
            api_port=8001,
            gate_port=8000,
            poll_interval=0.2,
            timeout_s=10.0,
        )


# ---------------------------------------------------------------------------------------
# Lệnh chạy
# ---------------------------------------------------------------------------------------
def test_runtime_command_co_live_mode_va_ghi_vao_m1_gate(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    command = gate._runtime_command(run_dir, api_port=8123, work=run_dir / "m1_gate")
    assert "--replay-session" in command
    assert command[command.index("--replay-session") + 1] == str(run_dir)
    # Bắt buộc: controller bỏ qua snapshot source_mode="replay".
    assert "--live-mode" in command
    assert "--replay-realtime" in command
    assert command[command.index("--api-port") + 1] == "8123"
    assert command[command.index("--output-dir") + 1] == str(run_dir / "m1_gate" / "runtime")
    assert command[command.index("--session-dir") + 1] == str(run_dir / "m1_gate" / "session")
    # Không dùng --cam1-video (REPORT_M1 / P7e).
    assert "--cam1-video" not in command
    assert "--cam2-video" not in command


def test_controller_command_khong_truyen_live_mode(tmp_path: Path) -> None:
    """``gate_session_controller.py`` KHÔNG có ``--live-mode``; truyền vào là argparse lỗi."""
    run_dir = tmp_path / "run"
    command = gate._controller_command(
        run_dir, gateway_url="http://127.0.0.1:8123/api/runtime/snapshot", gate_port=8124
    )
    assert "--live-mode" not in command
    assert "--runtime-url" in command
    assert command[command.index("--runtime-url") + 1] == (
        "http://127.0.0.1:8123/api/runtime/snapshot"
    )
    assert command[command.index("--gate-config") + 1] == str(
        run_dir / "techgar_config" / "gate_zones.json"
    )
    assert command[command.index("--port") + 1] == "8124"
    assert str(gate.CONTROLLER_SCRIPT) in command


def test_timeout_tinh_theo_so_frame(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "gt_frames.csv").write_text(
        "frame,S001\n0,0\n1,0\n2,0\n", encoding="utf-8"
    )
    assert gate._frames_in(run_dir) == 3


def test_child_environment_khong_buffer_nen_log_khong_mat_khi_terminate(tmp_path: Path) -> None:
    import subprocess
    import sys
    import time

    environment = gate._child_environment(tmp_path / "s.json")
    assert environment["PYTHONUNBUFFERED"] == "1"
    log_path = tmp_path / "child.log"
    with log_path.open("w", encoding="utf-8") as log:
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; print('[ENTRY] x', flush=False); time.sleep(30)"],
            stdout=log, stderr=subprocess.STDOUT, text=True, env=environment,
        )
        time.sleep(1.5)
        child.terminate()
        child.wait(10)
    assert "[ENTRY] x" in log_path.read_text(encoding="utf-8")

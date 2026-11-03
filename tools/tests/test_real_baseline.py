"""Test ``real_baseline`` (P16b) trên dữ liệu tổng hợp — không cần replay thật.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import json
import shutil
import types
from pathlib import Path

import m1_gate_eval as gate
import pytest
import real_baseline as baseline


def _write_predictions(path: Path, records: list[dict]) -> Path:
    path.write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
        encoding="utf-8",
    )
    return path


def _slot(camera: str, slot_id: str, occupied: bool, gid: int | None = None) -> dict:
    return {
        "camera_id": camera,
        "slot_id": slot_id,
        "occupied": occupied,
        "canonical_vehicle_gid": gid,
    }


def _observation(camera: str, gid: int | None) -> dict:
    return {"camera_id": camera, "canonical_gid": gid}


def _event(event_type: str) -> dict:
    return {"event_type": event_type}


# ---------------------------------------------------------------------------------------
# summarize_predictions
# ---------------------------------------------------------------------------------------
def test_summarize_predictions_gom_dung_nhom_su_kien(tmp_path: Path) -> None:
    path = _write_predictions(
        tmp_path / "predictions.jsonl",
        [
            {
                "frame_idx": 1,
                "identity_events": [
                    _event("global_id_created"),
                    _event("handoff_opened"),
                ],
                "observations": [_observation("cam1", 1)],
                "slots": [_slot("cam1", "A01", True, 1)],
            },
            {
                "frame_idx": 2,
                "identity_events": [
                    _event("global_id_merged"),
                    _event("dormant_global_id_recovered"),
                    _event("handoff_matched"),
                    _event("handoff_rejected"),
                    _event("local_track_lost"),
                ],
                "observations": [
                    _observation("cam1", 1),
                    _observation("cam2", 1),
                ],
                "slots": [
                    _slot("cam1", "A01", True, 1),
                    _slot("cam2", "A02", False),
                ],
            },
            {
                "frame_idx": 3,
                "identity_events": [_event("same_camera_duplicate_merged")],
                "observations": [_observation("cam2", 2)],
                "slots": [
                    _slot("cam1", "A01", False),
                    _slot("cam2", "A02", True, 2),
                ],
            },
        ],
    )

    summary = baseline.summarize_predictions(path)

    assert summary["frames"] == 3
    assert summary["new_gid"] == 1
    # global_id_merged + same_camera_duplicate_merged
    assert summary["merge"] == 2
    # dormant_global_id_recovered (handoff_matched đếm riêng)
    assert summary["re_id"] == 1
    assert summary["handoff"] == {"opened": 1, "matched": 1, "rejected": 1}
    assert summary["local_track_lost"] == 1
    assert summary["unique_gids"] == [1, 2]
    assert summary["unique_gid_count"] == 2
    # handoff_matched_target_gallery cũng phải vào nhóm matched.
    assert summary["event_counts"]["handoff_matched"] == 1


def test_summarize_predictions_coverage_va_occupancy(tmp_path: Path) -> None:
    path = _write_predictions(
        tmp_path / "predictions.jsonl",
        [
            {
                "frame_idx": 1,
                "observations": [_observation("cam1", 1)],
                "slots": [_slot("cam1", "A01", True, 1)],
            },
            {
                "frame_idx": 2,
                "observations": [
                    _observation("cam1", 1),
                    _observation("cam2", 1),
                ],
                "slots": [
                    _slot("cam1", "A01", True, 1),
                    _slot("cam2", "A02", False),
                ],
            },
            {
                "frame_idx": 3,
                "observations": [_observation("cam2", 2)],
                "slots": [
                    _slot("cam1", "A01", False),
                    _slot("cam2", "A02", True, 2),
                ],
            },
        ],
    )

    summary = baseline.summarize_predictions(path)

    assert summary["per_camera"]["cam1"]["frames_with_gid"] == 2
    assert summary["per_camera"]["cam1"]["gid_frame_coverage"] == pytest.approx(2 / 3, abs=1e-4)
    assert summary["per_camera"]["cam2"]["frames_with_gid"] == 2
    assert summary["per_camera"]["cam2"]["gid_frame_coverage"] == pytest.approx(2 / 3, abs=1e-4)

    occupancy = summary["occupancy"]
    assert occupancy["ground_truth_available"] is False
    assert occupancy["slot_count"] == 2
    slots = {(row["camera_id"], row["slot_id"]): row for row in occupancy["slots"]}
    assert slots[("cam1", "A01")]["occupied_frames"] == 2
    assert slots[("cam1", "A01")]["final_occupied"] is False
    assert slots[("cam2", "A02")]["occupied_frames"] == 1
    assert slots[("cam2", "A02")]["final_occupied"] is True
    assert slots[("cam2", "A02")]["canonical_gids"] == [2]
    assert occupancy["mean_occupied_ratio"] == pytest.approx(0.58335, abs=1e-4)


def test_summarize_predictions_bo_qua_dong_rong_va_event_thieu_ten(tmp_path: Path) -> None:
    path = tmp_path / "predictions.jsonl"
    path.write_text(
        "\n".join(
            [
                "",
                json.dumps({"frame_idx": 1, "identity_events": [{}]}),
                "",
            ]
        ),
        encoding="utf-8",
    )

    summary = baseline.summarize_predictions(path)

    assert summary["frames"] == 1
    assert summary["new_gid"] == 0
    assert summary["merge"] == 0
    assert summary["re_id"] == 0
    assert summary["event_counts"] == {"": 1}


# ---------------------------------------------------------------------------------------
# Đếm tay
# ---------------------------------------------------------------------------------------
def test_manual_counts_default_va_override() -> None:
    default = baseline._manual_counts_for("session_hiep2", {})
    assert default is not None
    assert default["vehicles_in"] == 2
    assert default["vehicles_out"] == 2

    override = baseline._manual_counts_for(
        "session_hiep2",
        {"session_hiep2": {"vehicles_in": 3, "vehicles_out": 1, "method": "test"}},
    )
    assert override == {"vehicles_in": 3, "vehicles_out": 1, "method": "test"}

    assert baseline._manual_counts_for("khong_ton_tai", {}) is None


# ---------------------------------------------------------------------------------------
# Parse log controller (dùng lại m1_gate_eval đã sửa mất log)
# ---------------------------------------------------------------------------------------
def test_parse_controller_log_dem_entry_exit() -> None:
    text = "\n".join(
        [
            "[GATE] started",
            "[ENTRY] Global ID #7 -> session ses-abc",
            "noise",
            "[EXIT] Global ID #7 -> deleted session ses-abc",
            "[ENTRY] Global ID #8 -> session ses-def",
        ]
    )

    events = gate.parse_controller_log(text)

    assert [(event.kind, event.global_id, event.session_id) for event in events] == [
        ("gate_in", 7, "ses-abc"),
        ("gate_out", 7, "ses-abc"),
        ("gate_in", 8, "ses-def"),
    ]


# ---------------------------------------------------------------------------------------
# Bộ config: session (recovered) vs root (bộ dùng lúc quay)
# ---------------------------------------------------------------------------------------
def test_materialize_root_config_tao_du_5_file_chuan(tmp_path: Path) -> None:
    target = baseline.materialize_root_config(tmp_path)

    assert target == tmp_path / "_configs" / "root"
    for filename in baseline.CONFIG_FILES:
        assert (target / filename).is_file(), filename
    calibration = json.loads((target / "calibration.json").read_text(encoding="utf-8"))
    # Bộ gốc dùng hệ cm (khớp gate_zones.json) — sai đơn vị là bẫy đã gặp ở P13.
    assert calibration["world"]["unit"] == "cm"


def test_resolve_session_root_bo_qua_config_session() -> None:
    with pytest.raises(ValueError):
        baseline.resolve_session("session_hiep2", config_set="khong_co")


def test_resolve_session_config_set_ghi_dung_thu_muc(tmp_path: Path) -> None:
    spec_session = baseline.resolve_session(
        "session_hiep2", config_set=baseline.CONFIG_SET_SESSION
    )
    assert spec_session.config_name == "droidcam_shared_hiep2"

    spec_root = baseline.resolve_session(
        "session_hiep2", config_set=baseline.CONFIG_SET_ROOT, work_root=tmp_path
    )
    assert spec_root.config_name == "root"
    assert spec_root.video_dir == spec_session.video_dir
    assert spec_root.config_dir == (tmp_path / "_configs" / "root").resolve()


# ---------------------------------------------------------------------------------------
# Quy định tiết kiệm đĩa (director): chặn khi < 2 GB, luôn --no-session-video
# ---------------------------------------------------------------------------------------
def test_ensure_free_space_dung_khi_duoi_nguong(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        baseline.shutil,
        "disk_usage",
        lambda _path: types.SimpleNamespace(total=0, used=0, free=int(1.5 * 1024**3)),
    )
    with pytest.raises(RuntimeError, match="Dừng theo quy định tiết kiệm đĩa"):
        baseline.ensure_free_space(tmp_path, 2.0)


def test_ensure_free_space_cho_chay_khi_du(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        baseline.shutil,
        "disk_usage",
        lambda _path: types.SimpleNamespace(total=0, used=0, free=int(5 * 1024**3)),
    )
    baseline.ensure_free_space(tmp_path, 2.0)  # không ném


def test_runtime_command_luon_co_no_session_video(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = baseline._load_gate_helpers()
    captured: dict[str, list[str]] = {}

    def fake_run_and_measure(run_dir: Path, **_kwargs: object):
        # Gọi đúng wrapper đã patch để xem lệnh runtime thật sự nhận được.
        captured["cmd"] = gate._runtime_command(  # type: ignore[attr-defined]
            run_dir, api_port=1, work=tmp_path
        )
        raise RuntimeError("dừng sớm — test chỉ cần lệnh")

    monkeypatch.setattr(gate, "run_and_measure", fake_run_and_measure)
    with pytest.raises(RuntimeError, match="dừng sớm"):
        baseline.run_gate_measurement(
            tmp_path,
            api_port=1,
            gate_port=2,
            poll_interval=0.1,
            timeout_s=1.0,
            skip_run=False,
            extra_runtime_args=("--legacy-departure-token-distance",),
        )

    command = captured["cmd"]
    assert command.count("--no-session-video") == 1
    assert command[-1] == "--legacy-departure-token-distance"


# ---------------------------------------------------------------------------------------
# Pin mã: replay không bị agent khác sửa backend giữa lúc đo
# ---------------------------------------------------------------------------------------
def test_pin_code_worktree_va_head(tmp_path: Path) -> None:
    pinned = baseline.pin_code(tmp_path, baseline.CODE_SOURCE_WORKTREE)
    assert (pinned / "runtime_server.py").is_file()
    assert (pinned / "two_camera.py").is_file()
    assert (pinned / "src" / "techgar" / "cross_camera_manager.py").is_file()
    # ``two_camera.py`` còn ``import tools.rectangle_line_calibration`` — gói
    # ``tools/`` nằm ngoài ``src/``, thiếu nó là replay chết ngay.
    assert (pinned / "tools" / "rectangle_line_calibration.py").is_file()
    assert (pinned / "tools" / "__init__.py").is_file()
    # Gọi lại phải trả đúng thư mục cũ (không pin lại lần hai).
    assert baseline.pin_code(tmp_path, baseline.CODE_SOURCE_WORKTREE) == pinned

    head = baseline.pin_code(tmp_path, baseline.CODE_SOURCE_HEAD)
    assert (head / "runtime_server.py").is_file()
    assert (head / "src" / "techgar" / "cross_camera_manager.py").is_file()
    assert (head / "tools" / "rectangle_line_calibration.py").is_file()
    assert head != pinned


def test_pin_code_dung_lai_ban_cu_nhung_thieu_file_thi_dung_lai(tmp_path: Path) -> None:
    pinned = baseline.pin_code(tmp_path, baseline.CODE_SOURCE_WORKTREE)
    # Giả lập bản pin hỏng kiểu cũ: thiếu gói ``tools/`` và thiếu manifest.
    shutil.rmtree(pinned / "tools")
    (pinned / "_pin_manifest.json").unlink()
    again = baseline.pin_code(tmp_path, baseline.CODE_SOURCE_WORKTREE)
    assert again == pinned
    assert (again / "tools" / "rectangle_line_calibration.py").is_file()


def test_pin_code_tu_choi_nguon_la(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="code_source"):
        baseline.pin_code(tmp_path, "khong_co")


def test_code_state_cua_ban_pin_khong_lay_hash_worktree(tmp_path: Path) -> None:
    pinned = baseline.pin_code(tmp_path, baseline.CODE_SOURCE_HEAD)
    state = baseline.code_state(pinned)
    assert state["head"] == f"pinned:{pinned.name}"
    # Sửa file trong bản pin ⇒ hash phải đổi, chứng minh state đọc đúng bản pin.
    target = pinned / "src" / "techgar" / "cross_camera_manager.py"
    before = state["files"]["src/techgar/cross_camera_manager.py"]
    target.write_text(target.read_text(encoding="utf-8") + "\n# test\n", encoding="utf-8")
    after = baseline.code_state(pinned)["files"]["src/techgar/cross_camera_manager.py"]
    assert before != after


# ---------------------------------------------------------------------------------------
# Bảng markdown: dán thẳng vào REPORT, không phải chép tay số
# ---------------------------------------------------------------------------------------
def _fake_document(*, stable: bool = True) -> dict:
    return {
        "generated_at": "2026-11-03T10:00:00+07:00",
        "method": {
            "code_source": "head",
            "pinned_code": "out/_code/head-827f8db9",
            "config_set": "root",
            "tag": "before",
            "extra_runtime_args": [],
        },
        "totals": {
            "frames": 642,
            "new_gid": 2,
            "merge": 0,
            "re_id": 3,
            "handoff_opened": 7,
            "handoff_matched": 4,
            "local_track_lost": 19,
            "controller_entry": 2,
            "controller_exit": 2,
            "manual_vehicles_in": 2,
            "manual_vehicles_out": 2,
        },
        "sessions": [
            {
                "session": "session_hiep2",
                "frames": 642,
                "identity": {
                    "new_gid": 2,
                    "merge": 0,
                    "re_id": 3,
                    "handoff": {"opened": 7, "matched": 4},
                    "local_track_lost": 19,
                    "per_camera": {
                        "cam1": {"gid_frame_coverage": 0.3707},
                        "cam2": {"gid_frame_coverage": 0.6059},
                    },
                },
                "gate": {
                    "controller_entry": 2,
                    "controller_exit": 2,
                    "manual": {"vehicles_in": 2, "vehicles_out": 2},
                },
                "code_state": {
                    "before": {"head": "827f8db9"},
                    "after": {"head": "827f8db9" if stable else "deadbeef"},
                },
            }
        ],
    }


def test_render_markdown_du_dong_va_cot() -> None:
    table = baseline.render_markdown(_fake_document())
    rows = [line for line in table.splitlines() if line.startswith("|")]
    assert len(rows) == 4  # header + separator + 1 session + TOTAL
    assert "`session_hiep2`" in rows[2]
    assert "0.37 / 0.61" in rows[2]
    assert "| có |" in rows[2]
    assert rows[3].startswith("| **TOTAL** | 642 | 2 | 0 | 3 | 7/4 |")
    assert "config: `root`" in table


def test_render_markdown_danh_dau_ma_khong_on_dinh() -> None:
    table = baseline.render_markdown(_fake_document(stable=False))
    assert "KHÔNG" in table

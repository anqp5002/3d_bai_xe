"""Test phần chấm điểm của ``p16_accept`` (P16f) bằng dữ liệu giả — không replay gì.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import json
from pathlib import Path

import p16_accept as accept
import pytest


# ---------------------------------------------------------------------------------------
# Đọc số từ JSON của các tool
# ---------------------------------------------------------------------------------------
def test_bundle_from_doc_dung_ba_json() -> None:
    gate = {
        "controller": {"gate_in": 3, "gate_out": 3},
        "gate_ideal": {"entry": 3, "exit": 3},
    }
    metrics = {"occupancy": {"accuracy": 0.97}}
    track = {
        "frame_recall": {"cam2": {"gid_ratio": 0.8}},
        "per_car": {"hard_breaks_total": 4, "hard_breaks_max": 2, "gid_reuse_count": 0},
    }
    bundle = accept.bundle_from(gate, metrics, track)
    assert bundle.gate_in_text == "3/3"
    assert bundle.gate_out_text == "3/3"
    assert bundle.hard_breaks_total == 4
    assert bundle.hard_breaks_max == 2
    assert bundle.gid_reuse == 0
    assert bundle.cam2_gid_ratio == pytest.approx(0.8)
    assert bundle.occupancy == pytest.approx(0.97)


def test_bundle_from_gate_loi_thi_de_none() -> None:
    """``gate_result.json`` có ``ok: false`` là lỗi đo, không phải "0 lượt" — phải là None."""
    bundle = accept.bundle_from({"ok": False, "error": "boom"}, None, None)
    assert bundle.gate_in is None
    assert bundle.gate_out is None


def test_bundle_from_track_loi_khong_lay_so() -> None:
    bundle = accept.bundle_from(None, None, {"error": "không import được"})
    assert bundle.hard_breaks_total is None
    assert bundle.cam2_gid_ratio is None


def test_stored_bundle_doc_ket_qua_da_luu(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "m1_gate").mkdir(parents=True)
    (run / "m1").mkdir(parents=True)
    (run / "m1_gate" / "gate_result.json").write_text(
        json.dumps(
            {
                "controller": {"gate_in": 2, "gate_out": 1},
                "gate_ideal": {"entry": 3, "exit": 3},
            }
        ),
        encoding="utf-8",
    )
    (run / "m1" / "metrics.json").write_text(
        json.dumps(
            {
                "occupancy": {"accuracy": 0.96},
                "track": {
                    "frame_recall": {"cam2": {"gid_ratio": 0.66}},
                    "per_car": {
                        "hard_breaks_total": 20,
                        "hard_breaks_max": 18,
                        "gid_reuse_count": 3,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    bundle = accept.stored_bundle(run)
    assert (bundle.gate_in, bundle.gate_out) == (2, 1)
    assert bundle.hard_breaks_total == 20
    assert bundle.gid_reuse == 3
    assert bundle.cam2_gid_ratio == pytest.approx(0.66)
    assert bundle.sources["gate"].endswith("gate_result.json")


def test_stored_bundle_thieu_file_tra_none(tmp_path: Path) -> None:
    bundle = accept.stored_bundle(tmp_path / "khong-co-gi")
    assert bundle.gate_in is None
    assert bundle.occupancy is None
    assert bundle.sources == {}


# ---------------------------------------------------------------------------------------
# K2
# ---------------------------------------------------------------------------------------
def _k2_ok() -> accept.Bundle:
    return accept.Bundle(
        gate_in=3,
        gate_out=3,
        ideal_in=3,
        ideal_out=3,
        hard_breaks_total=5,
        hard_breaks_max=2,
        gid_reuse=0,
        cam2_gid_ratio=0.8,
        occupancy=0.96,
    )


def test_k2_dat_khi_moi_chi_so_trong_nguong() -> None:
    rows = accept.score_k2(accept.Bundle(), _k2_ok())
    assert [row.passed for row in rows] == [True] * 6
    assert "3/3" in rows[0].after_text


def test_k2_truot_khi_cong_thieu_luot() -> None:
    after = _k2_ok()
    after.gate_in = 2
    rows = accept.score_k2(accept.Bundle(), after)
    by_metric = {row.metric: row for row in rows}
    assert by_metric["cổng vào (controller/GT lý tưởng)"].passed is False
    assert by_metric["cổng ra (controller/GT lý tưởng)"].passed is True


def test_k2_truot_khi_dut_that_qua_nguong_hoac_moi_xe_qua_3() -> None:
    after = _k2_ok()
    after.hard_breaks_total = 7
    by_metric = {row.metric: row for row in accept.score_k2(accept.Bundle(), after)}
    assert by_metric["đứt THẬT tổng"].passed is False

    after = _k2_ok()
    after.hard_breaks_max = 4
    by_metric = {row.metric: row for row in accept.score_k2(accept.Bundle(), after)}
    assert by_metric["đứt THẬT tổng"].passed is True
    assert by_metric["đứt THẬT max/xe"].passed is False


def test_k2_truot_khi_cam2_gid_hoac_occupancy_duoi_nguong() -> None:
    after = _k2_ok()
    after.cam2_gid_ratio = 0.749
    after.occupancy = 0.949
    by_metric = {row.metric: row for row in accept.score_k2(accept.Bundle(), after)}
    assert by_metric["cam2 frame có GID"].passed is False
    assert by_metric["occupancy frame-ô"].passed is False


def test_k2_khong_do_duoc_thi_khong_cham() -> None:
    rows = accept.score_k2(accept.Bundle(), accept.Bundle())
    assert all(row.passed is None for row in rows)
    assert all(row.after_text == "không đo" for row in rows)


# ---------------------------------------------------------------------------------------
# K4
# ---------------------------------------------------------------------------------------
def test_k4_dat_khi_gid_khong_dung_chung_va_cong_lech_toi_da_1() -> None:
    before = accept.Bundle(gid_reuse=3, hard_breaks_total=40, hard_breaks_max=12)
    after = accept.Bundle(
        gate_in=6,
        gate_out=5,
        ideal_in=6,
        ideal_out=6,
        hard_breaks_total=9,
        hard_breaks_max=3,
        gid_reuse=0,
    )
    rows = accept.score_k4(before, after)
    assert [row.passed for row in rows] == [True] * 4
    assert rows[3].after_text == "+0/-1"


def test_k4_truot_khi_gid_con_dung_chung_hoac_cong_lech_2() -> None:
    after = accept.Bundle(
        gate_in=8,
        gate_out=6,
        ideal_in=6,
        ideal_out=6,
        hard_breaks_total=9,
        hard_breaks_max=3,
        gid_reuse=1,
    )
    by_metric = {row.metric: row for row in accept.score_k4(accept.Bundle(), after)}
    assert by_metric["GID dùng chung"].passed is False
    assert by_metric["cổng lệch vào/ra (controller − ideal)"].passed is False


def test_k4_truot_khi_dut_that_qua_12() -> None:
    after = accept.Bundle(
        gate_in=6,
        gate_out=6,
        ideal_in=6,
        ideal_out=6,
        hard_breaks_total=13,
        hard_breaks_max=3,
        gid_reuse=0,
    )
    by_metric = {row.metric: row for row in accept.score_k4(accept.Bundle(), after)}
    assert by_metric["đứt THẬT tổng"].passed is False
    assert by_metric["GID dùng chung"].passed is True


# ---------------------------------------------------------------------------------------
# K7 / đêm mưa: chỉ ghi số
# ---------------------------------------------------------------------------------------
def test_so_chi_ghi_so_khong_cham() -> None:
    rows = accept.score_numbers_only(
        accept.Bundle(gate_in=1, ideal_in=10), accept.Bundle(), "K7"
    )
    assert len(rows) == 5
    assert all(row.passed is None for row in rows)


# ---------------------------------------------------------------------------------------
# R4 video thật
# ---------------------------------------------------------------------------------------
def _real_doc(new_gid: int, merge: int, re_id: int, entry: int, manual_in: int, occ: float):
    return {
        "totals": {
            "new_gid": new_gid,
            "merge": merge,
            "re_id": re_id,
            "controller_entry": entry,
            "manual_vehicles_in": manual_in,
            "controller_exit": entry,
            "manual_vehicles_out": manual_in,
        },
        "sessions": [
            {
                "session": "s",
                "identity": {"new_gid": new_gid, "merge": merge, "re_id": re_id},
                "gate": {
                    "controller_entry": entry,
                    "controller_exit": entry,
                    "manual": {"vehicles_in": manual_in, "vehicles_out": manual_in},
                },
                "occupancy": {"mean_occupied_ratio": occ},
            }
        ],
    }


def test_real_dat_khi_tat_ca_khong_thoai_lui() -> None:
    before = _real_doc(new_gid=7, merge=0, re_id=6, entry=6, manual_in=6, occ=0.80)
    after = _real_doc(new_gid=7, merge=0, re_id=5, entry=6, manual_in=6, occ=0.80)
    rows = accept.score_real(before, after)
    assert [row.passed for row in rows] == [True] * 6


def test_real_truot_khi_gid_moi_tang_qua_10_phan_tram() -> None:
    before = _real_doc(new_gid=10, merge=0, re_id=6, entry=6, manual_in=6, occ=0.8)
    after = _real_doc(new_gid=12, merge=0, re_id=6, entry=6, manual_in=6, occ=0.8)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["số GID mới"].passed is False

    # Đúng biên +10 % thì vẫn đạt.
    after = _real_doc(new_gid=11, merge=0, re_id=6, entry=6, manual_in=6, occ=0.8)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["số GID mới"].passed is True


def test_real_truot_khi_merge_hoac_reid_tang() -> None:
    before = _real_doc(new_gid=7, merge=1, re_id=6, entry=6, manual_in=6, occ=0.8)
    after = _real_doc(new_gid=7, merge=2, re_id=7, entry=6, manual_in=6, occ=0.8)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["[merge] đã hoàn tất"].passed is False
    assert by_metric["[re-id]"].passed is False


def test_real_truot_khi_entry_xa_hon_dem_tay() -> None:
    before = _real_doc(new_gid=7, merge=0, re_id=6, entry=6, manual_in=6, occ=0.8)
    after = _real_doc(new_gid=7, merge=0, re_id=6, entry=4, manual_in=6, occ=0.8)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["ENTRY lệch đếm tay"].before == 0
    assert by_metric["ENTRY lệch đếm tay"].after == 2
    assert by_metric["ENTRY lệch đếm tay"].passed is False


def test_real_truot_khi_occupancy_giam_qua_0_5_diem() -> None:
    before = _real_doc(new_gid=7, merge=0, re_id=6, entry=6, manual_in=6, occ=0.80)
    after = _real_doc(new_gid=7, merge=0, re_id=6, entry=6, manual_in=6, occ=0.794)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["occupancy trung bình (3 session)"].passed is False

    after = _real_doc(new_gid=7, merge=0, re_id=6, entry=6, manual_in=6, occ=0.795)
    by_metric = {row.metric: row for row in accept.score_real(before, after)}
    assert by_metric["occupancy trung bình (3 session)"].passed is True


def test_real_thieu_baseline_before_thi_khong_cham_va_co_ghi_chu() -> None:
    rows = accept.score_real(None, _real_doc(1, 0, 0, 1, 1, 0.5), missing_note="thiếu file")
    assert len(rows) == 6
    assert all(row.passed is None for row in rows)
    assert all(row.note == "thiếu file" for row in rows)


# ---------------------------------------------------------------------------------------
# Tổng hợp, đĩa, CLI, in
# ---------------------------------------------------------------------------------------
def test_summarize_khong_dat_khi_co_dong_truot() -> None:
    rows = [
        accept.Row("K2", "a", 1, 1, "=1", True),
        accept.Row("K2", "b", 1, 2, "=1", False),
    ]
    summary = accept.summarize(rows)
    assert summary == {"pass": 1, "fail": 1, "unmeasured": 0, "verdict": "KHÔNG ĐẠT"}


def test_summarize_chua_cham_het_thi_chua_dat() -> None:
    """Dòng không đo được/K7 chưa chấm ⇒ chưa thể kết luận ĐẠT."""
    summary = accept.summarize([accept.Row("K7", "a", None, None, "số", None)])
    assert summary["unmeasured"] == 1
    assert summary["verdict"] == "KHÔNG ĐẠT"


def test_parse_only_loc_va_giu_thu_tu() -> None:
    assert accept.parse_only("k4,k2") == ["k2", "k4"]
    assert accept.parse_only(None) == list(accept.SCENARIO_ORDER)
    with pytest.raises(ValueError):
        accept.parse_only("k9")


def test_build_command_ghi_co_dung_kieu(tmp_path: Path) -> None:
    """Lệnh ghi vào REPORT không được thành ``--skip-real True`` (argparse không nhận)."""
    args = accept.parser().parse_args(
        ["--only", "k2", "--skip-real", "--out-dir", str(tmp_path), "--min-free-gb", "3"]
    )
    command = accept.build_command(args)
    assert "--skip-real" in command.split()
    assert "True" not in command
    assert "--only k2" in command
    assert accept.parser().parse_args(command.split()[1:]).skip_real is True


def test_ensure_free_space_dung_khi_duoi_nguong(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        accept.shutil, "disk_usage", lambda _path: type("U", (), {"free": 2 * 1024**3})()
    )
    with pytest.raises(accept.InsufficientSpace, match="2.00 GB"):
        accept.ensure_free_space(tmp_path, 3.0)


def test_ensure_free_space_tra_so_gb(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        accept.shutil, "disk_usage", lambda _path: type("U", (), {"free": 8 * 1024**3})()
    )
    assert accept.ensure_free_space(tmp_path, 3.0) == pytest.approx(8.0)


def test_cell_dinh_dang_percent_va_khong_do() -> None:
    assert accept.Row("K2", "x", None, 0.755, "≥ 75 %", True, fmt="pct").after_text == "75.5 %"
    assert accept.Row("K2", "x", None, None, "≥ 75 %", None, fmt="pct").before_text == "không đo"


def _document() -> dict:
    rows = accept.score_k2(
        accept.Bundle(gate_in=2, gate_out=1, ideal_in=3, ideal_out=3),
        accept.Bundle(
            gate_in=3,
            gate_out=3,
            ideal_in=3,
            ideal_out=3,
            hard_breaks_total=4,
            hard_breaks_max=2,
            gid_reuse=0,
            cam2_gid_ratio=0.8,
            occupancy=0.96,
        ),
    )
    return {
        "command": "p16_accept.py --only k2 --skip-real",
        "generated_at": "2026-11-03T20:00:00+07:00",
        "seconds": 12.0,
        "free_gb": 32.0,
        "rows": [row.to_dict() for row in rows],
        "summary": accept.summarize(rows),
        "runs": {},
        "real": None,
        "notes": [],
    }


def test_render_table_va_markdown_co_du_cot() -> None:
    document = _document()
    table = accept.render_table(document)
    assert "K2" in table
    assert "cổng vào" in table
    assert "2/3" in table and "3/3" in table

    markdown = accept.render_markdown(document)
    assert "| kịch bản | chỉ số | trước sửa | sau sửa | ngưỡng | kết quả | ghi chú |" in markdown
    assert "| K2 | cổng vào (controller/GT lý tưởng) | 2/3 | 3/3 |" in markdown
    assert "**Tổng:" in markdown

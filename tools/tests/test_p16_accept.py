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


# ---------------------------------------------------------------------------------------
# P16j — --repeat-real N: R4 chấm theo trung bình N lần
# ---------------------------------------------------------------------------------------
def _real_doc2(
    entry: int,
    exit_: int,
    *,
    new_gid: int = 7,
    merge: int = 0,
    re_id: int = 6,
    occ: float = 0.8,
    manual: int = 6,
):
    """Như ``_real_doc`` nhưng ENTRY và EXIT khác nhau (đúng thực tế video thật)."""
    doc = _real_doc(new_gid, merge, re_id, entry, manual, occ)
    doc["totals"]["controller_exit"] = exit_
    doc["totals"]["manual_vehicles_out"] = manual
    for session in doc["sessions"]:
        session["gate"]["controller_exit"] = exit_
        session["gate"]["manual"]["vehicles_out"] = manual
    return doc


def _real_runs(state: str, docs: list[dict]) -> list[accept.RealRun]:
    return [
        accept.RealRun(
            state=state,
            index=index,
            path=Path(f"{state}{index}.json"),
            doc=doc,
            call={"returncode": 0, "seconds": 1.0},
        )
        for index, doc in enumerate(docs, 1)
    ]


def test_repeat_real_mac_dinh_3_va_doi_duoc() -> None:
    assert accept.parser().parse_args([]).repeat_real == accept.REAL_REPEAT_DEFAULT == 3
    assert accept.parser().parse_args(["--repeat-real", "5"]).repeat_real == 5


def test_build_command_co_repeat_real_va_parse_lai_duoc() -> None:
    args = accept.parser().parse_args(["--repeat-real", "4"])
    command = accept.build_command(args)
    assert "--repeat-real 4" in command
    assert accept.parser().parse_args(command.split()[1:]).repeat_real == 4


def test_aggregate_real_runs_tinh_values_tb_min() -> None:
    runs = _real_runs("after", [_real_doc2(6, 4), _real_doc2(6, 2), _real_doc2(6, 3)])
    agg = accept.aggregate_real_runs(runs)
    assert agg["exit"]["values"] == [4.0, 2.0, 3.0]
    assert agg["exit"]["mean"] == pytest.approx(3.0)
    assert agg["exit"]["min"] == 2.0
    assert agg["entry"]["mean"] == pytest.approx(6.0)
    assert agg["ok_runs"] == 3 and agg["runs"] == 3


def test_aggregate_real_runs_bo_qua_lan_loi() -> None:
    runs = _real_runs("after", [_real_doc2(6, 4), _real_doc2(6, 2)])
    runs.append(accept.RealRun(state="after", index=3, path=Path("x"), doc=None))
    agg = accept.aggregate_real_runs(runs)
    assert agg["exit"]["values"] == [4.0, 2.0]
    assert agg["ok_runs"] == 2 and agg["runs"] == 3


def test_real_lap_dat_khi_trung_binh_khong_giam() -> None:
    before = _real_runs("before", [_real_doc2(6, 2)] * 3)
    after = _real_runs("after", [_real_doc2(6, 4), _real_doc2(6, 3), _real_doc2(6, 5)])
    rows = accept.score_real_repeated(before, after)
    by_metric = {row.metric: row for row in rows}
    assert by_metric["ENTRY trung bình (N lần)"].passed is True
    assert by_metric["EXIT trung bình (N lần)"].passed is True
    assert by_metric["EXIT trung bình (N lần)"].before == pytest.approx(2.0)
    assert by_metric["EXIT trung bình (N lần)"].after == pytest.approx(4.0)
    # min chỉ để xem độ ổn định, nằm trong ghi chú chứ không thành dòng chấm riêng
    assert "2/2/2" in by_metric["EXIT trung bình (N lần)"].note
    assert "min 2" in by_metric["EXIT trung bình (N lần)"].note


def test_real_lap_truot_khi_trung_binh_exit_giam() -> None:
    before = _real_runs("before", [_real_doc2(6, 3)] * 3)
    after = _real_runs("after", [_real_doc2(6, 1), _real_doc2(6, 2), _real_doc2(6, 2)])
    by_metric = {
        row.metric: row for row in accept.score_real_repeated(before, after)
    }
    assert by_metric["EXIT trung bình (N lần)"].passed is False


def test_real_lap_truot_khi_trung_binh_entry_giam() -> None:
    before = _real_runs("before", [_real_doc2(6, 4)] * 3)
    after = _real_runs("after", [_real_doc2(5, 4), _real_doc2(6, 4), _real_doc2(6, 4)])
    by_metric = {
        row.metric: row for row in accept.score_real_repeated(before, after)
    }
    assert by_metric["ENTRY trung bình (N lần)"].passed is False
    assert by_metric["EXIT trung bình (N lần)"].passed is True


def test_real_lap_giu_cac_tieu_chi_r4_khac() -> None:
    before = _real_runs(
        "before", [_real_doc2(6, 2, new_gid=10, merge=1, re_id=6, occ=0.80)] * 3
    )
    after = _real_runs(
        "after", [_real_doc2(6, 4, new_gid=12, merge=2, re_id=7, occ=0.79)] * 3
    )
    by_metric = {
        row.metric: row for row in accept.score_real_repeated(before, after)
    }
    assert by_metric["số GID mới (TB N lần)"].passed is False
    assert by_metric["[merge] đã hoàn tất (TB)"].passed is False
    assert by_metric["[re-id] (TB)"].passed is False
    assert by_metric["occupancy trung bình (TB)"].passed is False


def test_real_lap_bien_gid_moi_10_phan_tram() -> None:
    before = _real_runs("before", [_real_doc2(6, 2, new_gid=10)] * 3)
    after = _real_runs("after", [_real_doc2(6, 2, new_gid=11)] * 3)
    by_metric = {
        row.metric: row for row in accept.score_real_repeated(before, after)
    }
    assert by_metric["số GID mới (TB N lần)"].passed is True


def test_real_lap_thieu_ket_qua_thi_khong_cham() -> None:
    rows = accept.score_real_repeated(
        [], _real_runs("after", [_real_doc2(6, 4)]), missing_note="lỗi"
    )
    assert len(rows) == 6
    assert all(row.passed is None for row in rows)
    assert all(row.note == "lỗi" for row in rows)


def test_score_all_dung_duong_lap_khi_co_runs() -> None:
    before = _real_runs("before", [_real_doc2(6, 2)] * 3)
    after = _real_runs("after", [_real_doc2(6, 4)] * 3)
    rows = accept.score_all(
        ["real"],
        sim_results={},
        real_before=None,
        real_after=None,
        real_before_runs=before,
        real_after_runs=after,
    )
    assert len(rows) == 6
    assert {row.metric for row in rows} >= {
        "ENTRY trung bình (N lần)",
        "EXIT trung bình (N lần)",
    }


def test_measure_real_state_chay_n_lan_tach_tag_va_code_source(
    tmp_path: Path, monkeypatch
) -> None:
    calls: list[list[str]] = []

    def fake_run_tool(tool, args, log_path, timeout_s):
        calls.append(list(args))
        out = Path(args[args.index("--out") + 1])
        out.write_text(json.dumps(_real_doc2(6, 3)), encoding="utf-8")
        return {
            "tool": tool,
            "command": [tool],
            "log": str(log_path),
            "returncode": 0,
            "seconds": 1.0,
        }

    monkeypatch.setattr(accept, "run_tool", fake_run_tool)
    monkeypatch.setattr(accept, "ensure_free_space", lambda path, min_gb: 99.0)

    runs = accept.measure_real_state("before", 2, tmp_path, min_free_gb=0)
    assert [run.index for run in runs] == [1, 2]
    assert all(run.state == "before" and run.ok for run in runs)
    assert [args[args.index("--code-source") + 1] for args in calls] == ["head", "head"]
    assert [args[args.index("--tag") + 1] for args in calls] == ["before1", "before2"]
    assert [Path(args[args.index("--out") + 1]).name for args in calls] == [
        "baseline_before_run1.json",
        "baseline_before_run2.json",
    ]


def test_measure_real_state_after_dung_worktree_va_kiem_dia_moi_lan(
    tmp_path: Path, monkeypatch
) -> None:
    calls: list[list[str]] = []
    checks: list[float] = []

    def fake_run_tool(tool, args, log_path, timeout_s):
        calls.append(list(args))
        Path(args[args.index("--out") + 1]).write_text(
            json.dumps(_real_doc2(6, 4)), encoding="utf-8"
        )
        return {"tool": tool, "command": [tool], "log": str(log_path), "returncode": 0}

    def fake_ensure(path, min_gb):
        checks.append(min_gb)
        return 99.0

    monkeypatch.setattr(accept, "run_tool", fake_run_tool)
    monkeypatch.setattr(accept, "ensure_free_space", fake_ensure)

    accept.measure_real_state("after", 3, tmp_path, min_free_gb=3.0)
    assert [args[args.index("--code-source") + 1] for args in calls] == [
        "worktree",
        "worktree",
        "worktree",
    ]
    assert len(checks) == 3


# ---------------------------------------------------------------------------------------
# P16l — --reuse-before: đọc kết quả before đã lưu, không replay
# ---------------------------------------------------------------------------------------
def _write_before(path: Path, *, code_source: str | None = "head", **overrides) -> Path:
    doc = _real_doc2(6, 2)
    if code_source is not None:
        doc["method"] = {"code_source": code_source}
    doc["totals"].update(overrides)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_reuse_before_mo_thu_muc_lay_moi_file_baseline_before(tmp_path: Path) -> None:
    for name in ("baseline_before_r1.json", "baseline_before_r2.json", "khac.json"):
        _write_before(tmp_path / name)
    paths = accept.expand_reuse_before([str(tmp_path)])
    assert [path.name for path in paths] == [
        "baseline_before_r1.json",
        "baseline_before_r2.json",
    ]


def test_reuse_before_mo_glob_va_file_le(tmp_path: Path) -> None:
    for name in ("a_r1.json", "a_r2.json", "a_r3.json"):
        _write_before(tmp_path / name)
    globbed = accept.expand_reuse_before([str(tmp_path / "a_r*.json")])
    assert [path.name for path in globbed] == ["a_r1.json", "a_r2.json", "a_r3.json"]

    explicit = accept.expand_reuse_before(
        [str(tmp_path / "a_r2.json"), str(tmp_path / "a_r1.json")]
    )
    assert [path.name for path in explicit] == ["a_r2.json", "a_r1.json"]


def test_reuse_before_glob_khong_khop_bao_loi(tmp_path: Path) -> None:
    with pytest.raises(accept.ReuseBeforeError, match="không khớp"):
        accept.expand_reuse_before([str(tmp_path / "khong_co_*.json")])


def test_reuse_before_thu_muc_rong_bao_loi(tmp_path: Path) -> None:
    with pytest.raises(accept.ReuseBeforeError, match="baseline_before"):
        accept.expand_reuse_before([str(tmp_path)])


def test_reuse_before_thieu_file_bao_loi_ro(tmp_path: Path) -> None:
    missing = tmp_path / "khong_ton_tai.json"
    with pytest.raises(accept.ReuseBeforeError, match="không thấy file before"):
        accept.load_reuse_before([str(missing)])


def test_reuse_before_json_sai_bao_loi(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{khong phai json", encoding="utf-8")
    with pytest.raises(accept.ReuseBeforeError, match="JSON object"):
        accept.load_reuse_before([str(bad)])


def test_reuse_before_thieu_totals_bao_loi(tmp_path: Path) -> None:
    bad = tmp_path / "thieu.json"
    bad.write_text(json.dumps({"sessions": []}), encoding="utf-8")
    with pytest.raises(accept.ReuseBeforeError, match="totals"):
        accept.load_reuse_before([str(bad)])

    thieu_khoa = _write_before(tmp_path / "thieu_khoa.json")
    doc = json.loads(thieu_khoa.read_text(encoding="utf-8"))
    del doc["totals"]["controller_exit"]
    thieu_khoa.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(accept.ReuseBeforeError, match="controller_exit"):
        accept.load_reuse_before([str(thieu_khoa)])


def test_reuse_before_file_worktree_bi_tu_choi(tmp_path: Path) -> None:
    bad = _write_before(tmp_path / "after.json", code_source="worktree")
    with pytest.raises(accept.ReuseBeforeError, match="worktree"):
        accept.load_reuse_before([str(bad)])


def test_reuse_before_load_tao_real_run_danh_dau_da_luu(tmp_path: Path) -> None:
    _write_before(tmp_path / "b1.json")
    _write_before(tmp_path / "b2.json")
    runs = accept.load_reuse_before(
        [str(tmp_path / "b1.json"), str(tmp_path / "b2.json")]
    )
    assert [run.index for run in runs] == [1, 2]
    assert all(run.state == "before" and run.ok for run in runs)
    assert all(run.call["reused"] is True for run in runs)
    agg = accept.aggregate_real_runs(runs)
    assert agg["entry"]["mean"] == pytest.approx(6.0)
    assert agg["exit"]["mean"] == pytest.approx(2.0)


def test_reuse_before_khop_voi_score_va_ghi_lenh(tmp_path: Path) -> None:
    before = accept.load_reuse_before([str(_write_before(tmp_path / "b1.json"))])
    after = _real_runs("after", [_real_doc2(6, 4)])
    rows = accept.score_real_repeated(before, after)
    assert {row.metric: row for row in rows}["EXIT trung bình (N lần)"].passed is True

    args = accept.parser().parse_args(
        ["--only", "real", "--reuse-before", str(tmp_path / "b1.json")]
    )
    command = accept.build_command(args)
    assert "--reuse-before" in command
    parsed = accept.parser().parse_args(command.split()[1:])
    assert parsed.reuse_before == [str(tmp_path / "b1.json")]


def test_parser_reuse_before_nhan_nhieu_file(tmp_path: Path) -> None:
    args = accept.parser().parse_args(
        ["--reuse-before", "a.json", "b.json", "c.json", "--repeat-real", "2"]
    )
    assert args.reuse_before == ["a.json", "b.json", "c.json"]
    assert args.repeat_real == 2


def test_main_reuse_before_thieu_file_tra_2_va_khong_replay(
    tmp_path: Path, monkeypatch
) -> None:
    called: list[str] = []

    def fake_measure(*args, **kwargs):
        called.append("measure")
        return []

    monkeypatch.setattr(accept, "measure_real_state", fake_measure)
    code = accept.main(
        [
            "--only",
            "real",
            "--reuse-before",
            str(tmp_path / "khong_co.json"),
            "--out-dir",
            str(tmp_path),
        ]
    )
    assert code == 2
    assert called == []


def test_main_reuse_before_voi_skip_real_tra_2() -> None:
    code = accept.main(["--skip-real", "--reuse-before", "x.json"])
    assert code == 2

"""Test ``check_gate_in`` (P10e mục 2) trên ``gt_events.csv`` tổng hợp.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import json
from pathlib import Path

import check_gate_in as cgi
import pytest

COLUMNS = [
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


def write_events(run_dir: Path, rows: list[dict[str, str]]) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    path = run_dir / "gt_events.csv"
    lines = [",".join(COLUMNS)]
    for row in rows:
        lines.append(",".join(row.get(column, "") for column in COLUMNS))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_moi_xe_them_deu_co_gate_in_thi_dat(tmp_path: Path) -> None:
    run = tmp_path / "run-ok"
    write_events(
        run,
        [
            {"car": "V001", "slot": "S010", "gate_in_frame": "102", "initial_parked": "0"},
            {"car": "V002", "slot": "S029", "gate_in_frame": "50", "initial_parked": "0"},
            # Xe đỗ sẵn: gate_in rỗng là ĐÚNG.
            {"car": "V003", "slot": "S095", "initial_parked": "1"},
        ],
    )
    result = cgi.check_run(run)
    assert result["ok"] is True
    assert result["cars_added"] == 2
    assert result["cars_initial_parked"] == 1
    assert result["missing_gate_in"] == []


def test_xe_them_khong_co_gate_in_thi_lech(tmp_path: Path) -> None:
    """Đúng lỗi cũ: xe `queued` không bao giờ vào bãi ⇒ thiếu gate_in."""
    run = tmp_path / "run-bad"
    write_events(
        run,
        [
            {"car": "V001", "slot": "S010", "gate_in_frame": "102", "initial_parked": "0"},
            {"car": "V002", "slot": "S029", "initial_parked": "0"},
        ],
    )
    result = cgi.check_run(run)
    assert result["ok"] is False
    assert [item["car"] for item in result["missing_gate_in"]] == ["V002"]  # type: ignore[index]


def test_xe_do_san_khong_bi_dem_la_thieu(tmp_path: Path) -> None:
    run = tmp_path / "run-parked"
    write_events(run, [{"car": "V001", "slot": "S001", "initial_parked": "1"}])
    result = cgi.check_run(run)
    assert result["ok"] is True
    assert result["cars_added"] == 0


def test_thieu_file_nem_loi(tmp_path: Path) -> None:
    with pytest.raises(cgi.GateInError, match="không thấy"):
        cgi.check_run(tmp_path / "khong-co")


def test_thieu_cot_nem_loi(tmp_path: Path) -> None:
    run = tmp_path / "run-thieu-cot"
    run.mkdir(parents=True)
    (run / "gt_events.csv").write_text("car,slot\nV001,S001\n", encoding="utf-8")
    with pytest.raises(cgi.GateInError, match="thiếu cột"):
        cgi.check_run(run)


def test_initial_parked_rac_nem_loi(tmp_path: Path) -> None:
    run = tmp_path / "run-rac"
    write_events(
        run, [{"car": "V001", "slot": "S010", "gate_in_frame": "5", "initial_parked": "x"}]
    )
    with pytest.raises(cgi.GateInError, match="initial_parked"):
        cgi.check_run(run)


def test_describe_doc_duoc_ca_truong_hop_lech(tmp_path: Path) -> None:
    run = tmp_path / "run-desc"
    write_events(run, [{"car": "V002", "slot": "S029", "initial_parked": "0"}])
    line = cgi.describe(run)
    assert line.startswith("LỆCH")
    assert "V002(S029)" in line


def test_read_verify_doc_json(tmp_path: Path) -> None:
    run = tmp_path / "run-verify"
    run.mkdir()
    (run / "verify.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
    assert cgi.read_verify(run) == {"ok": True}
    assert cgi.read_verify(tmp_path / "khong-co") is None


def test_main_tra_ma_1_khi_co_run_lech(tmp_path: Path) -> None:
    bad = tmp_path / "bad"
    write_events(bad, [{"car": "V001", "slot": "S010", "initial_parked": "0"}])
    assert cgi.main([str(bad)]) == 1


def test_main_tra_ma_0_khi_dat(tmp_path: Path) -> None:
    ok = tmp_path / "ok"
    write_events(
        ok, [{"car": "V001", "slot": "S010", "gate_in_frame": "9", "initial_parked": "0"}]
    )
    assert cgi.main([str(ok)]) == 0

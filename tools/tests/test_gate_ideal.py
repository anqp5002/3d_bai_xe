"""Test phần ANS_18 của ``m1_gate_eval``: đọc và so ``gt_gate_ideal.csv``.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import m1_gate_eval as gate
import pytest


def write_ideal(path: Path, rows: list[tuple[str, int, str, int]]) -> Path:
    lines = ["car_id,frame,kind,visible"]
    for car, frame, kind, visible in rows:
        lines.append(f"{car},{frame},{kind},{visible}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_read_gate_ideal_doc_dung() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = write_ideal(
            Path(tmp) / "gt_gate_ideal.csv",
            [("V001", 100, "entry", 1), ("V001", 900, "exit", 1)],
        )
        rows = gate.read_gate_ideal(path)
        assert [(r.car_id, r.frame, r.kind, r.visible) for r in rows] == [
            ("V001", 100, "entry", 1),
            ("V001", 900, "exit", 1),
        ]


def test_read_gate_ideal_khong_co_file_tra_rong(tmp_path: Path) -> None:
    """Run xuất trước ANS_18 không có file — không được ném lỗi."""
    assert gate.read_gate_ideal(tmp_path / "khong-co.csv") == []


def test_read_gate_ideal_thieu_cot_nem_loi(tmp_path: Path) -> None:
    path = tmp_path / "gt_gate_ideal.csv"
    path.write_text("car_id,frame\nV001,1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="thiếu cột"):
        gate.read_gate_ideal(path)


def test_read_gate_ideal_kind_la_nem_loi(tmp_path: Path) -> None:
    path = tmp_path / "gt_gate_ideal.csv"
    path.write_text("car_id,frame,kind,visible\nV001,1,foo,1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="kind"):
        gate.read_gate_ideal(path)


def test_count_ideal_chi_dem_dong_visible(tmp_path: Path) -> None:
    path = write_ideal(
        tmp_path / "gt_gate_ideal.csv",
        [
            ("V001", 100, "entry", 1),
            ("V001", 900, "exit", 1),
            ("V002", 200, "entry", 0),  # camera không thấy → không kỳ vọng TechGAR đếm
            ("V002", 950, "exit", 1),
        ],
    )
    assert gate.count_ideal(gate.read_gate_ideal(path)) == (1, 2)


def test_build_ideal_mismatches_thieu_luot() -> None:
    ideal = [gate.IdealRow("V001", 100, "entry", 1)]
    rows = gate.build_ideal_mismatches([], ideal)
    assert len(rows) == 1
    assert rows[0]["reason"] == "thieu_luot"
    assert rows[0]["car"] == "V001"
    assert rows[0]["ideal_frame"] == 100


def test_build_ideal_mismatches_dem_them() -> None:
    """Controller đếm 2 lần, GT lý tưởng 1 → lượt thứ 2 là ``dem_them``."""
    events = [
        gate.ControllerEvent("gate_in", 7, "s1", 3, frame=100),
        gate.ControllerEvent("gate_in", 8, "s2", 9, frame=200),
    ]
    ideal = [gate.IdealRow("V001", 100, "entry", 1)]
    rows = gate.build_ideal_mismatches(events, ideal)
    assert len(rows) == 1
    assert rows[0]["reason"] == "dem_them"
    assert rows[0]["controller_frame"] == 200


def test_build_ideal_mismatches_lech_frame() -> None:
    events = [gate.ControllerEvent("gate_in", 7, "s1", 3, frame=105)]
    ideal = [gate.IdealRow("V001", 100, "entry", 1)]
    rows = gate.build_ideal_mismatches(events, ideal)
    assert rows[0]["reason"] == "lech_frame"
    assert rows[0]["delta"] == 5


def test_build_ideal_mismatches_khop_hoan_toan() -> None:
    events = [
        gate.ControllerEvent("gate_in", 7, "s1", 3, frame=100),
        gate.ControllerEvent("gate_out", 7, "s1", 4, frame=900),
    ]
    ideal = [
        gate.IdealRow("V001", 100, "entry", 1),
        gate.IdealRow("V001", 900, "exit", 1),
    ]
    assert gate.build_ideal_mismatches(events, ideal) == []


def test_build_ideal_mismatches_bo_qua_dong_khong_visible() -> None:
    """Dòng ``visible=0`` không tạo kỳ vọng → không sinh ``thieu_luot``.

    Nếu controller vẫn đếm được thì đó là ``dem_them`` — đúng như vậy, vì camera không
    thấy điểm cắt thì về lý thuyết không thể đếm được.
    """
    ideal = [gate.IdealRow("V002", 500, "entry", 0)]
    # Controller không đếm gì → không có ca lệch.
    assert gate.build_ideal_mismatches([], ideal) == []
    # Controller có đếm → ``dem_them`` (không phải ``thieu_luot``).
    events = [gate.ControllerEvent("gate_in", 7, "s1", 3, frame=100)]
    rows = gate.build_ideal_mismatches(events, ideal)
    assert [row["reason"] for row in rows] == ["dem_them"]


def test_build_ideal_mismatches_khong_gan_duoc_frame() -> None:
    """Lượt controller không gán được frame vẫn phải hiện, không im lặng."""
    events = [gate.ControllerEvent("gate_in", 7, "s1", 3, frame=None)]
    ideal = [gate.IdealRow("V001", 100, "entry", 1)]
    rows = gate.build_ideal_mismatches(events, ideal)
    assert rows[0]["reason"] == "khong_gan_duoc_frame"

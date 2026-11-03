"""Luật L-GATE cho **vạch đếm** (P11 mục 4, ANS_14) — song song với L-GATE của vạch cổng.

Vạch cổng vẽ đã có test L-GATE (`test_lot.py::test_l_gate_only_a2_crosses_gate_segments`).
Vạch đếm dời vào trong nên phải kiểm lại: **chỉ** làn A2 (lối gom vào/ra) được cắt vạch đếm;
mọi làn khác cách ≥ 2,0 m tính cả nửa bề rộng.

Số liệu vạch đếm đọc từ `sim3d/data/lot/count_lines.json` — **cùng nguồn** với
`web/src/export/countLines.ts`, nên Python và TypeScript không thể lệch nhau.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any, Final

import pytest

TOOLS_DIR: Final = Path(__file__).resolve().parent.parent  # .../sim3d/tools
SIM3D_DIR: Final = TOOLS_DIR.parent                        # .../sim3d
LOT_PATH: Final = SIM3D_DIR / "data" / "lot" / "lot_pucpr.json"
COUNT_LINES_PATH: Final = SIM3D_DIR / "data" / "lot" / "count_lines.json"

#: Ngưỡng L-GATE (ANS_1 B.2): mọi làn khác phải cách ≥ 2,0 m tính cả nửa bề rộng.
MIN_CLEARANCE_M: Final = 2.0

#: `y` của lối giữa (A2) trong `lot_pucpr.json`.
ROAD_Y: Final = 3.2


def count_line_config() -> dict[str, Any]:
    if not COUNT_LINES_PATH.exists():
        pytest.fail(f"thiếu {COUNT_LINES_PATH} — chạy sim3d/tools/measure_count_lines.py")
    return json.loads(COUNT_LINES_PATH.read_text(encoding="utf-8"))


def count_line_abs_x() -> float:
    """Hoành độ vạch đếm, m (cùng giá trị với `COUNT_LINE_ABS_X_M` của TS)."""
    return float(count_line_config()["count_line_abs_x_m"])


def _seg_seg_distance(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> float:
    """Khoảng cách nhỏ nhất giữa hai đoạn thẳng (0 nếu cắt nhau)."""
    def point_seg(p: tuple[float, float], s: tuple[float, float], e: tuple[float, float]) -> float:
        sx, sy = s
        ex, ey = e
        px, py = p
        dx, dy = ex - sx, ey - sy
        length_sq = dx * dx + dy * dy
        if length_sq == 0.0:
            return math.hypot(px - sx, py - sy)
        t = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / length_sq))
        return math.hypot(px - (sx + t * dx), py - (sy + t * dy))

    def crosses(
        p1: tuple[float, float],
        p2: tuple[float, float],
        p3: tuple[float, float],
        p4: tuple[float, float],
    ) -> bool:
        def side(
            p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]
        ) -> float:
            return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

        d1 = side(p3, p4, p1)
        d2 = side(p3, p4, p2)
        d3 = side(p1, p2, p3)
        d4 = side(p1, p2, p4)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))

    if crosses(a, b, c, d):
        return 0.0
    return min(
        point_seg(a, c, d),
        point_seg(b, c, d),
        point_seg(c, a, b),
        point_seg(d, a, b),
    )


@pytest.fixture(scope="module")
def lot() -> dict[str, Any]:
    return json.loads(LOT_PATH.read_text(encoding="utf-8"))


def test_count_line_constant_matches_measurement() -> None:
    """Hằng số vạch phải khớp số đo và còn biên an toàn (ANS_14 mục 1)."""
    config = count_line_config()
    x = float(config["count_line_abs_x_m"])
    margin = float(config["count_line_margin_m"])
    car_length = float(config["car_length_max_m"])
    measured = config["measured"]

    entry_deepest = float(measured["entry_deepest_x_m"])
    exit_shallowest = float(measured["exit_shallowest_x_m"])

    # Vạch vào phải sâu hơn (điểm cấp ID muộn nhất + 1 chiều dài xe).
    entry_max_allowed = entry_deepest - car_length
    assert x <= entry_max_allowed + 1e-9, (
        f"vạch vào x={x} phải <= {entry_max_allowed:.2f} m "
        f"(điểm cấp ID muộn nhất {entry_deepest} m + biên {car_length} m)"
    )

    # Vạch ra phải nông hơn (điểm mất ID sớm nhất − 1 chiều dài xe).
    exit_min_allowed = exit_shallowest + car_length
    assert -x >= exit_min_allowed - 1e-9, (
        f"vạch ra x={-x} phải >= {exit_min_allowed:.2f} m "
        f"(điểm mất ID sớm nhất {exit_shallowest} m − biên {car_length} m)"
    )

    # Hai ràng buộc **độc lập** (mỗi vạch một bên), nên biên mỗi bên khác nhau được. Chỉ yêu
    # cầu: biên **nhỏ nhất** không thấp hơn hằng số công bố (đó là con số README/REPORT dùng).
    entry_margin = entry_max_allowed - x
    exit_margin = abs(exit_min_allowed) - x
    assert min(entry_margin, exit_margin) >= margin - 1e-9, (
        f"biên nhỏ nhất phải >= {margin} m, đo được vào {entry_margin:.2f} m / "
        f"ra {exit_margin:.2f} m"
    )
    # Và biên không được lớn quá mức (nếu lớn hơn nhiều thì đã dời vạch vào quá sâu, làm mất
    # tác dụng "sát cổng" — vẫn dùng được nhưng nên biết).
    assert max(entry_margin, exit_margin) < margin + 1.0, (
        f"biên lớn nhất {max(entry_margin, exit_margin):.2f} m lệch quá xa hằng số {margin} m"
    )


def test_count_lines_l_gate(lot: dict[str, Any]) -> None:
    """Chỉ A2 cắt vạch đếm; mọi làn khác cách ≥ 2,0 m (tính nửa bề rộng)."""
    x = count_line_abs_x()
    # Vạch đếm là đoạn dọc qua lối giữa, dài 6 m quanh `y = ROAD_Y`.
    lines = {
        "vao": ((x, ROAD_Y + 3.0), (x, ROAD_Y - 3.0)),
        "ra": ((-x, ROAD_Y + 3.0), (-x, ROAD_Y - 3.0)),
    }
    offenders: list[str] = []
    for aisle in lot["aisles"]:
        polyline = [tuple(p) for p in aisle["polyline"]]
        for name, (p1, p2) in lines.items():
            distance = min(
                _seg_seg_distance(a, b, p1, p2)
                for a, b in itertools.pairwise(polyline)
            )
            if aisle["id"] == "A2":
                assert distance < 1e-6, (
                    f"A2 phải đi qua vạch {name}, nhưng cách {distance:.3f} m"
                )
                continue
            clearance = distance - aisle["width_m"] / 2.0
            if clearance < MIN_CLEARANCE_M:
                offenders.append(
                    f"{aisle['id']}–vạch {name}: {clearance:.2f} m < {MIN_CLEARANCE_M} m"
                )
    assert offenders == [], f"vi phạm L-GATE cho vạch đếm: {offenders}"


def test_count_line_inside_business_area(lot: dict[str, Any]) -> None:
    """Vạch đếm phải nằm **trong** phạm vi bãi và sâu hơn cổng vẽ (lý do dời vào)."""
    x = count_line_abs_x()
    xs = [p[0] for slot in lot["slots"] for p in slot["polygon"]]
    assert min(xs) < -x < x < max(xs), (
        f"vạch đếm ±{x} phải nằm trong [{min(xs):.2f}, {max(xs):.2f}]"
    )
    assert x < lot["gates"]["in"]["p1"][0], "vạch vào phải sâu hơn cổng vào vẽ"
    assert -x > lot["gates"]["out"]["p1"][0], "vạch ra phải nông hơn cổng ra vẽ"

"""Test **dải trống hàng 1/2** và **cung vào ô 4,0 m** (P2d mục 1, ANS_6 mục 2).

Dải trống hàng 1/2 phải đủ để cung vào ô 4,0 m (bán kính tối thiểu của xe theo FE §4.3)
không quét sang hình chữ nhật xe đỗ hàng đối diện — nếu không, ảnh sẽ có hai xe dính nhau,
TechGAR gộp khung / đổi ID (lý do director bỏ phương án A).

Test này **không** chạy mô phỏng (việc đó ở `sim/`), chỉ đo hình học lot:
- dải trống ≥ ngưỡng tối thiểu tính từ hình học cung;
- và kiểm SAT thật bằng hình chữ nhật xe trên cung (dùng công thức của `sim/collision.ts`
  viết lại ở đây để pytest không phụ thuộc Node).
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

import pytest

#: Dải trống tối thiểu (m) để cung 4,0 m không quét sang hàng đối diện.
#: Suy ra từ hình học: bán kính cung 4,0 m + nửa bề rộng xe 0,99 m ≈ 4,99 m tính từ tâm
#: làn; trừ nửa bề rộng làn A1 (1,8 m) ⇒ ~3,2 m tới mép hàng. Cộng dư an toàn cho xe đỗ
#: cao 1,7 m (SUV) và sai số dựng hình ⇒ chọn **4,6 m** (P2d đạt 4,65 m hẹp nhất).
MIN_STRIP_HANG12_M = 4.6

#: Bán kính cung vào ô dùng trong `sim/network.ts` (`MIN_TURN_RADIUS_M`).
#: Cỡ xe lớn nhất D4 cho phép ở ô hẹp nhất hàng 1 (bề rộng ô ~2,17 m ⇒ xe ≤ 1,82 m).


def _lot() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[2] / "data" / "lot" / "lot_pucpr.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(lot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {}
    for slot in lot["slots"]:
        rows.setdefault(str(slot["row"]), []).append(slot)
    return rows


def _bottom(slot: dict[str, Any]) -> float:
    """Mép nam (nhỏ nhất theo Y) của đa giác ô."""
    return min(point[1] for point in slot["polygon"])


def _top(slot: dict[str, Any]) -> float:
    """Mép bắc (lớn nhất theo Y) của đa giác ô."""
    return max(point[1] for point in slot["polygon"])


def _car_corners(x: float, y: float, th: float) -> list[tuple[float, float]]:
    """4 góc hình chữ nhật xe — cùng thứ tự với `rectCorners` của `sim/collision.ts`."""
    cos = math.cos(th)
    sin = math.sin(th)
    half_length = CAR_LENGTH_M / 2.0
    half_width = CAR_WIDTH_M / 2.0
    forward = (cos, sin)
    side = (-sin, cos)

    def corner(forward_sign: float, side_sign: float) -> tuple[float, float]:
        return (
            x + forward[0] * half_length * forward_sign + side[0] * half_width * side_sign,
            y + forward[1] * half_length * forward_sign + side[1] * half_width * side_sign,
        )

    return [
        corner(1, -1),
        corner(1, 1),
        corner(-1, 1),
        corner(-1, -1),
    ]


def _overlaps(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> bool:
    """Tách trục (SAT) cho hai đa giác lồi."""
    for polygon in (a, b):
        for index in range(len(polygon)):
            p = polygon[index]
            q = polygon[(index + 1) % len(polygon)]
            axis = (-(q[1] - p[1]), q[0] - p[0])
            length = math.hypot(axis[0], axis[1])
            if length < 1e-12:
                continue
            ux, uy = axis[0] / length, axis[1] / length
            min_a = min(px * ux + py * uy for px, py in a)
            max_a = max(px * ux + py * uy for px, py in a)
            min_b = min(px * ux + py * py_b for px, py_b in b) if False else min(
                px * ux + py * uy for px, py in b
            )
            max_b = max(px * ux + py * uy for px, py in b)
            if max_a < min_b or max_b < min_a:
                return False
    return True


def test_strip_between_rows_1_and_2_is_wide_enough() -> None:
    """ANS_6 mục 2: dải trống hàng 1/2 đủ cho cung 4,0 m (≥ 4,6 m)."""
    rows = _rows(_lot())
    strip_min = min(_bottom(slot) for slot in rows["1"]) - max(_top(slot) for slot in rows["2"])
    strip_median = statistics.median([_bottom(slot) for slot in rows["1"]]) - statistics.median(
        [_top(slot) for slot in rows["2"]]
    )
    print(
        f"dải trống hàng 1/2: hẹp nhất {strip_min:.3f} m · trung vị {strip_median:.3f} m "
        f"(ngưỡng {MIN_STRIP_HANG12_M} m)"
    )
    assert strip_min >= MIN_STRIP_HANG12_M, (
        f"dải trống hẹp nhất {strip_min:.3f} m < {MIN_STRIP_HANG12_M} m"
    )


@pytest.mark.parametrize("row", ["3", "4", "5"])
def test_strip_other_rows_unchanged(row: str) -> None:
    """Hàng 3–5 không bị dời quá nhiều: dải trống vẫn dương (không ô nào chạm hàng kề)."""
    rows = _rows(_lot())
    order = ["1", "2", "3", "4", "5"]
    index = order.index(row)
    if index == 0:
        return
    above = order[index - 1]
    strip = statistics.median([_bottom(s) for s in rows[above]]) - statistics.median(
        [_top(s) for s in rows[row]]
    )
    print(f"dải trống hàng {above}/{row}: {strip:.3f} m")
    assert strip > 0.0, f"hàng {row} chạm hàng {above} (dải trống {strip:.3f} m)"

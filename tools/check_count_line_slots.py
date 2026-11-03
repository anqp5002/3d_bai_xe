"""ANS_16 muc 8: vach dem KHONG duoc cat / cach < 0,5 m bat ky da giac o nao (100 o + trang tri).

Vach hien tai: doan thang dung tai x = +-COUNT_LINE_ABS_X_M, y lay tu cong ve
(lot.gates.in.p1[1] .. p2[1]).

Chay: python sim3d/tools/check_count_line_slots.py
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any, Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
LOT_PATH: Final = SIM3D_DIR / "data" / "lot" / "lot_pucpr.json"
COUNT_LINES_PATH: Final = SIM3D_DIR / "data" / "lot" / "count_lines.json"

#: ANS_16 muc 8: khong duoc cach da giac o < 0,5 m.
MIN_SLOT_CLEARANCE_M: Final = 0.5

#: Khoang an toan da do (ASK_coders-1_1): vao x <= +20,65, ra x >= -20,76.
SAFE_MAX_ABS_X_M: Final = 20.65


def _point_seg_distance(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _seg_seg_distance(a, b, c, d) -> float:
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return 0.0
    return min(
        _point_seg_distance(a, c, d),
        _point_seg_distance(b, c, d),
        _point_seg_distance(c, a, b),
        _point_seg_distance(d, a, b),
    )


def _polygon_edges(polygon: list[list[float]]):
    pts = [tuple(p) for p in polygon]
    return list(zip(pts, pts[1:] + pts[:1]))


def clearances(lot: dict[str, Any], x: float, y0: float, y1: float) -> list[tuple[str, float]]:
    """Khoang cach tu vach (x, y0..y1) toi tung da giac o; tra [(slot_id, khoang_cach)]."""
    line = ((x, y0), (x, y1))
    out: list[tuple[str, float]] = []
    for slot in lot["slots"]:
        best = min(
            _seg_seg_distance(line[0], line[1], a, b) for a, b in _polygon_edges(slot["polygon"])
        )
        out.append((slot["id"], best))
    return out


def main() -> int:
    lot = json.loads(LOT_PATH.read_text(encoding="utf-8"))
    config = json.loads(COUNT_LINES_PATH.read_text(encoding="utf-8"))
    x = float(config["count_line_abs_x_m"])

    gate_in = lot["gates"]["in"]
    y0, y1 = min(gate_in["p1"][1], gate_in["p2"][1]), max(gate_in["p1"][1], gate_in["p2"][1])
    print(f"Vach hien tai: x=+-{x}, y {y0:.3f}..{y1:.3f} (lay tu cong ve)")
    print(f"Yeu cau ANS_16 muc 8: moi da giac o cach vach >= {MIN_SLOT_CLEARANCE_M} m")
    print()

    for name, sign in (("vao", +1), ("ra", -1)):
        xs = sign * x
        rows = clearances(lot, xs, y0, y1)
        worst = sorted(rows, key=lambda r: r[1])[:5]
        bad = [(sid, d) for sid, d in rows if d < MIN_SLOT_CLEARANCE_M]
        print(f"-- vach {name} x={xs:+.2f}")
        print(f"   5 o gan nhat: " + ", ".join(f"{sid}={d:.3f}" for sid, d in worst))
        if bad:
            print(f"   VI PHAM: {len(bad)} o cach < {MIN_SLOT_CLEARANCE_M} m: "
                  + ", ".join(f"{sid}({d:.3f})" for sid, d in bad))
        else:
            print(f"   OK: khong o nao cach < {MIN_SLOT_CLEARANCE_M} m")

    # Thu cac x khac trong khoang an toan neu vi pham
    print()
    print("=== Thu cac x khac trong khoang an toan |x| <= "
          f"{SAFE_MAX_ABS_X_M} ===")
    print(f"{'x':>7} {'o gan nhat':>12} {'khoang cach':>12}  ket qua")
    for candidate in (19.0, 19.2, 19.4, 19.6, 19.8, 20.0, 20.05, 20.2, 20.4, 20.6):
        rows = clearances(lot, candidate, y0, y1)
        worst_id, worst_d = min(rows, key=lambda r: r[1])
        ok = "OK" if worst_d >= MIN_SLOT_CLEARANCE_M else "VI PHAM"
        print(f"{candidate:>7.2f} {worst_id:>12} {worst_d:>12.3f}  {ok}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

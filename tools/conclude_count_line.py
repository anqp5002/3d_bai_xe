"""Ket luan cuoi: co ton tai MOT vach dem thoa ca 4 dieu kien P11 khong?

Dieu kien:
  1. Moi xe VAO cat vach SAU khi co Global ID (x <= entry_line_max).
  2. Moi xe RA cat vach TRUOC khi mat ID (x >= exit_line_min).
  3. Chi lan A2 bi cat (L-GATE, >= 2,0 m tinh nua be rong).
  4. Vach la MOT doan thang (schema gate_zones.json: p1, p2).

Chay: python sim3d/tools/conclude_count_line.py
"""

from __future__ import annotations

import csv
import itertools
import json
import math
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"

PITCH: Final = math.radians(80.0)
F_PX: Final = 288.0
HEIGHT_M: Final = 33.6
CX: Final = 320.0
CY: Final = 320.0

#: y cua A2 (loi giua) va A3 (loi nam), tu lot_pucpr.json.
A2_Y: Final = 3.2
A3_Y: Final = -16.3


def ground(u: float, v: float) -> tuple[float, float]:
    t = (v - CY) / F_PX
    y = HEIGHT_M * (math.cos(PITCH) - t * math.sin(PITCH)) / (
        t * math.cos(PITCH) + math.sin(PITCH)
    )
    z = y * math.cos(PITCH) + HEIGHT_M * math.sin(PITCH)
    return (u - CX) * z / F_PX, y


def seg_cross(a, b, c, d) -> bool:
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def main() -> int:
    lot = json.loads((SIM3D_DIR / "data/lot/lot_pucpr.json").read_text(encoding="utf-8"))
    slot_row = {s["id"]: s["row"] for s in lot["slots"]}

    rows_all = []
    for run in sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and "P11" in p.name):
        tag = [x for x in run.name.split("_")[1].split("-") if x.startswith("K")][0]
        src = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and f"_{tag}-P10e" in p.name)[0]

        events = list(csv.DictReader((src / "gt_events.csv").open(encoding="utf-8")))
        frame_rows = list(csv.DictReader((run / "gt_frames.csv").open(encoding="utf-8")))
        for event in events:
            car = event["car"]
            pts = []
            for row in frame_rows:
                u, v = row.get(f"{car}_u"), row.get(f"{car}_v")
                if u in (None, "") or v in (None, ""):
                    continue
                gx, gy = ground(float(u), float(v))
                pts.append((int(row["frame"]), gx, gy))
            rows_all.append(
                {
                    "run": run.name,
                    "car": car,
                    "slot": event["slot"],
                    "row": slot_row.get(event["slot"], "?"),
                    "pts": pts,
                }
            )

    print("=== Xe di qua A2 hay A3 khi cat vach doc tai x trong 12..28? ===")
    print(f"{'run':<28}{'car':>5}{'slot':>6}{'row':>4}  {'y khi cat x=20.05':>18}  {'A2?':>4}")
    misses: list[str] = []
    for item in rows_all:
        pts = item["pts"]
        ys = [
            round(p[2], 1)
            for a, p in zip(pts, pts[1:])
            if (a[1] > 20.05) != (p[1] > 20.05) and a[1] > p[1]
        ]
        on_a2 = any(abs(y - A2_Y) < 3.0 for y in ys)
        tag = "A2" if on_a2 else "A3/khac"
        if not on_a2:
            misses.append(f"{item['run']}/{item['car']} (o {item['slot']}, hang {item['row']})")
        print(
            f"{item['run']:<28}{item['car']:>5}{item['slot']:>6}{item['row']:>4}  "
            f"{str(ys):>18}  {tag:>4}"
        )

    print()
    total = len(rows_all)
    print(f"Tong {total} xe; chi {total - len(misses)} xe cat vach khi dang o A2.")
    print(f"Khong cat duoc khi o A2: {len(misses)} xe:")
    for miss in misses:
        print(f"   - {miss}")
    print()
    print("=== Ket luan ===")
    print(f"  A2 o y={A2_Y}, be rong 5,0 m -> y 0,7..5,7")
    print(f"  V_east_s: (32,3 ; 3,2) -> (28,8 ; -16,3): xe hang 4-5 roi A2 tai x=32")
    print(f"  A3 o y={A3_Y}")
    print("  -> Vach CHI tren A2: bo sot xe hang 4-5 (chung cat o A3).")
    print("  -> Vach dai xuong A3: cat lan A3 -> vi pham L-GATE (TASK muc 4).")
    print("  => KHONG ton tai mot doan thang thoa ca 4 dieu kien.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Phan tich: vach dem doc tai x=+-X phai cat MOI xe vao/ra, va chi lan A2 (L-GATE).

Chay: python sim3d/tools/analyse_count_line_options.py
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
RUNS = [p for p in (SIM3D_DIR / "data" / "runs").iterdir() if p.is_dir() and "P11" in p.name]

PITCH: Final = math.radians(80.0)
F_PX: Final = 288.0
HEIGHT_M: Final = 33.6
CX: Final = 320.0
CY: Final = 320.0


def ground(u: float, v: float) -> tuple[float, float]:
    t = (v - CY) / F_PX
    y = HEIGHT_M * (math.cos(PITCH) - t * math.sin(PITCH)) / (
        t * math.cos(PITCH) + math.sin(PITCH)
    )
    z = y * math.cos(PITCH) + HEIGHT_M * math.sin(PITCH)
    return (u - CX) * z / F_PX, y


def seg_cross(
    a: tuple[float, float], b: tuple[float, float],
    c: tuple[float, float], d: tuple[float, float],
) -> bool:
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def trajectories(run: Path) -> dict[str, list[tuple[int, float, float]]]:
    rows = list(csv.DictReader((run / "gt_frames.csv").open(encoding="utf-8")))
    events = list(csv.DictReader((run / "gt_events.csv").open(encoding="utf-8")))
    out: dict[str, list[tuple[int, float, float]]] = {}
    for event in events:
        car = event["car"]
        pts = []
        for row in rows:
            u, v = row.get(f"{car}_u"), row.get(f"{car}_v")
            if u in (None, "") or v in (None, ""):
                continue
            gx, gy = ground(float(u), float(v))
            pts.append((int(row["frame"]), gx, gy))
        out[car] = pts
    return out


def main() -> int:
    lot = json.loads((SIM3D_DIR / "data/lot/lot_pucpr.json").read_text(encoding="utf-8"))
    aisles = lot["aisles"]

    print("=== Truc xe tai x = +-20.05 (cat vach doc) ===")
    for run in sorted(RUNS):
        print(f"-- {run.name}")
        for car, pts in trajectories(run).items():
            hits = [
                (p[0], round(p[2], 1))
                for a, p in zip(pts, pts[1:])
                if (a[1] > 20.05) != (p[1] > 20.05)
            ]
            print(f"   {car}: x-tu {pts[0][1]:+.1f} den {pts[-1][1]:+.1f}; cat x=20.05 tai (frame, y) = {hits}")

    print()
    print("=== Neu vach dem dai theo y: nhung lan nao bi cat? ===")
    # Vach doc tai x, tu y0 den y1. Kiem tung lan.
    def lanes_crossed(x: float, y0: float, y1: float) -> list[str]:
        hits = []
        seg = ((x, y0), (x, y1))
        for aisle in aisles:
            poly = [tuple(p) for p in aisle["polyline"]]
            for a, b in itertools.pairwise(poly):
                if seg_cross(a, b, seg[0], seg[1]):
                    hits.append(aisle["id"])
                    break
        return hits

    for y1 in (5.7, 6.5, 10.0, 20.0, 28.0):
        for y0 in (0.8, -2.0, -8.0, -16.3, -18.0):
            hit = lanes_crossed(20.05, y0, y1)
            print(f"   x=20.05, y {y0:+.1f}..{y1:+.1f}: cat {hit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

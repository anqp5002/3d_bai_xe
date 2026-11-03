"""Tim mot vach dem (doan thang) thoa MOI dieu kien P11/ANS_14, hoac chung minh khong co.

Dieu kien:
  1. Cat MOI quy dao VAO sau frame TechGAR cap Global ID (xe da co ID truoc khi cat).
  2. Cat MOI quy dao RA truoc frame mat ID (ID con song khi cat).
  3. Khong cat lan nao khac ngoai lan vao/ra duoc phep (L-GATE: cach >= 2,0 m).

Chay: python sim3d/tools/search_count_line.py
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


def ground(u: float, v: float) -> tuple[float, float]:
    t = (v - CY) / F_PX
    y = HEIGHT_M * (math.cos(PITCH) - t * math.sin(PITCH)) / (
        t * math.cos(PITCH) + math.sin(PITCH)
    )
    z = y * math.cos(PITCH) + HEIGHT_M * math.sin(PITCH)
    return (u - CX) * z / F_PX, y


def seg_cross(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def load_trajectories(run: Path, src: Path | None = None) -> dict[str, list[tuple[int, float, float]]]:
    rows = list(csv.DictReader((run / "gt_frames.csv").open(encoding="utf-8")))
    events_file = (src / "gt_events.csv") if src is not None else (run / "gt_events.csv")
    events_rows = list(csv.DictReader(events_file.open(encoding="utf-8")))
    out: dict[str, list[tuple[int, float, float]]] = {}
    for event in events_rows:
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


def gid_frames(run_p10e: Path) -> tuple[dict[int, int], dict[int, int], dict[int, tuple[float, float]]]:
    """(gid->frame cap, gid->frame mat, gid->(x,y) luc cap)."""
    preds = run_p10e / "m1_gate" / "session" / "predictions.jsonl"
    first: dict[int, int] = {}
    last: dict[int, int] = {}
    firstpos: dict[int, tuple[float, float]] = {}
    with preds.open(encoding="utf-8") as handle:
        for line in handle:
            rec = json.loads(line)
            frame = int(rec["frame_idx"])
            for obs in rec.get("observations") or []:
                gid = obs.get("canonical_gid")
                world = obs.get("anchor_world")
                if gid is None or not isinstance(world, dict) or "x" not in world:
                    continue
                gid = int(gid)
                if gid not in first:
                    first[gid] = frame
                    firstpos[gid] = (float(world["x"]), float(world["y"]))
                last[gid] = frame
    return first, last, firstpos


def main() -> int:
    lot = json.loads((SIM3D_DIR / "data/lot/lot_pucpr.json").read_text(encoding="utf-8"))
    aisles = lot["aisles"]

    runs = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and "P11" in p.name)
    if not runs:
        raise SystemExit("khong thay run P11")

    def matching_p10e(run: Path) -> Path | None:
        """Run P10e cung kich ban (K2/K4/K6) — ten khac duoi nhan."""
        for part in run.name.split("_"):
            if part.startswith("K") and len(part) >= 2:
                tag = part.split("-")[0]
                found = sorted(
                    p
                    for p in RUNS_DIR.iterdir()
                    if p.is_dir() and f"_{tag}-P10e" in p.name
                )
                return found[0] if found else None
        return None

    print("=== Quy dao cac xe ===")
    all_traj: list[tuple[str, str, list[tuple[int, float, float]]]] = []
    gid_info: dict[str, tuple[dict[int, int], dict[int, int]]] = {}
    for run in runs:
        src = matching_p10e(run)
        if src is None or not (src / "m1_gate/session/predictions.jsonl").exists():
            print(f"   (bo qua {run.name}: khong co session P10e)")
            continue
        first, last, _ = gid_frames(src)
        gid_info[run.name] = (first, last)
        traj = load_trajectories(run, src)
        for car, pts in traj.items():
            all_traj.append((run.name, car, pts))
        print(f"   {run.name}: {len(traj)} xe, gid cap {sorted(first)[:3]}...")

    # Giai thich: moi quan he 'cat vach phai xay ra trong khoang frame nao'
    # Voi vao: sau first[gid]; voi ra: truoc last[gid].
    # Ta khong biet car nao = gid nao => dung dieu kien manh hon:
    #   vach phai cat MOI quy dao dung 1 lan o doan 'vao' (x > 0, huong -x)
    #   va dung 1 lan o doan 'ra' (x < 0).
    # Kiem theo 'cat vach khi x dang giam qua vach' va doi chieu gate_in/gate_out cua GT P10e.

    def check(line: tuple[tuple[float, float], tuple[float, float]]) -> tuple[bool, list[str]]:
        problems: list[str] = []
        p1, p2 = line
        # L-GATE: lan khac A2 khong duoc cat
        for aisle in aisles:
            if aisle["id"] == "A2":
                continue
            poly = [tuple(p) for p in aisle["polyline"]]
            for a, b in itertools.pairwise(poly):
                if seg_cross(a, b, p1, p2):
                    problems.append(f"cat lan {aisle['id']}")
                    break
        return (len(problems) == 0, problems)

    # Thu ho: cac vach doc tai nhieu x khac nhau, dai theo y khac nhau
    print()
    print("=== Thu vach DOC (x co dinh) chi tren A2 (y 0.5..6.0) ===")
    for x in (26, 24, 22, 20, 18, 16, 14, 12):
        line = ((x, 6.0), (x, 0.5))
        ok, problems = check(line)
        # dem so xe cat
        crossings = 0
        for _, car, pts in all_traj:
            if any(seg_cross(a[1:], b[1:], line[0], line[1]) for a, b in zip(pts, pts[1:])):
                crossings += 1
        print(f"   x={x:+3}: cat {crossings:>2}/{len(all_traj)} xe; L-GATE {'OK' if ok else problems}")

    print()
    print("=== Thu vach DOC dai xuong A3 (y -18..+6) — se cat ca A3 ===")
    for x in (26, 24, 22, 20, 18):
        line = ((x, 6.0), (x, -18.0))
        ok, problems = check(line)
        crossings = 0
        for _, car, pts in all_traj:
            if any(seg_cross(a[1:], b[1:], line[0], line[1]) for a, b in zip(pts, pts[1:])):
                crossings += 1
        print(f"   x={x:+3}: cat {crossings:>2}/{len(all_traj)} xe; L-GATE {'OK' if ok else problems}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

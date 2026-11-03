"""Kiem: vi tri cap / mat Global ID co cho phep mot vach dem duy nhat khong?

Chay: python sim3d/tools/verify_count_line_feasibility.py

Doc `m1_gate/session/predictions.jsonl` cua cac run P10e (da chay m1_gate_eval) va in:
  - vi tri (x, y) met world luc TechGAR cap Global ID lan dau
  - vi tri luc mat ID (lan cuoi con ID)
Dung de kiem dieu kien cua TASK_P11 muc 1 truoc khi chot vi tri vach.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"


def _read_positions(run: Path, *, first: bool) -> dict[int, tuple[int, float, float]]:
    """gid -> (frame, x, y). ``first=True``: lan dau co ID; ``False``: lan cuoi con ID."""
    preds = run / "m1_gate" / "session" / "predictions.jsonl"
    out: dict[int, tuple[int, float, float]] = {}
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
                if first:
                    if gid not in out:
                        out[gid] = (frame, float(world["x"]), float(world["y"]))
                else:
                    out[gid] = (frame, float(world["x"]), float(world["y"]))
    return out


def main() -> int:
    runs = sorted(
        p
        for p in RUNS_DIR.iterdir()
        if p.is_dir()
        and "P10e" in p.name
        and (p / "m1_gate" / "session" / "predictions.jsonl").exists()
    )
    if not runs:
        raise SystemExit("khong thay run P10e nao co m1_gate/session/predictions.jsonl")

    print("=== Vi tri cap / mat Global ID (met world) ===")
    entry_ys: list[float] = []
    for run in runs:
        firsts = _read_positions(run, first=True)
        lasts = _read_positions(run, first=False)
        print(f"-- {run.name}")
        for gid in sorted(firsts):
            f, x, y = firsts[gid]
            lf, lx, ly = lasts.get(gid, (0, float("nan"), float("nan")))
            print(
                f"   gid {gid:>2}: cap f{f:>5} (x={x:+7.2f}, y={y:+6.2f}) | "
                f"mat f{lf:>5} (x={lx:+7.2f}, y={ly:+6.2f})"
            )
            if x > 20.0:
                entry_ys.append(y)

    print()
    print("=== y luc CAP ID, chi cac xe con o phia dong (x > 20 m) ===")
    print("   ", [round(v, 1) for v in entry_ys])
    print("   A2 (loi giua) o y = 3.2, be rong 5.0 m -> y 0.7..5.7")
    print("   V_east_s: (32.0, 3.2) -> (28.8, -16.3)   [cheo xuong nam]")
    print("   A3 o y = -16.3")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

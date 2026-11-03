"""Do lai vi tri vach dem TREN CAC RUN P11c (sau khi template doi o).

Chay: python sim3d/tools/measure_count_lines_p11c.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"

#: Chieu dai xe lon nhat (SUV x1,1) de chua bien an toan.
CAR_LEN_M: Final = 5.17


def positions(run: Path) -> tuple[dict[int, tuple[int, float]], dict[int, tuple[int, float]]]:
    """(gid -> (frame, x) lan dau co ID, gid -> (frame, x) lan cuoi con ID)."""
    preds = run / "m1_gate" / "session" / "predictions.jsonl"
    first: dict[int, tuple[int, float]] = {}
    last: dict[int, tuple[int, float]] = {}
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
                x = float(world["x"])
                first.setdefault(gid, (frame, x))
                last[gid] = (frame, x)
    return first, last


def main() -> int:
    runs = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and "P11c" in p.name)
    if not runs:
        raise SystemExit("khong thay run P11c")

    all_first: list[float] = []
    all_last: list[float] = []
    for run in runs:
        first, last = positions(run)
        print(f"== {run.name}: {len(first)} gid")
        for gid in sorted(first):
            f, x = first[gid]
            lf, lx = last[gid]
            print(f"   gid {gid}: cap f{f:>5} x={x:+7.2f} | mat f{lf:>5} x={lx:+7.2f}")
            # Chi tinh xe di qua truc x mot lan theo huong tay (tu + sang -)
            if x > 0:
                all_first.append(x)
            if lx < 0:
                all_last.append(lx)

    print()
    print(f"Xe cap ID o phia dong (x>0): {len(all_first)} mau, x = {[round(v, 1) for v in sorted(all_first)]}")
    print(f"Xe mat ID o phia tay (x<0): {len(all_last)} mau, x = {[round(v, 1) for v in sorted(all_last)]}")
    if not all_first or not all_last:
        print()
        print("=> KHONG du mau de dat vach dem: thieu xe cap ID o phia dong hoac mat ID o phia tay.")
        return 1

    entry_max = min(all_first) - CAR_LEN_M
    exit_min = max(all_last) + CAR_LEN_M
    print()
    print(f"Vach vao phai x <= {entry_max:+.2f} m (diem cap ID muon nhat {min(all_first):+.2f} - {CAR_LEN_M})")
    print(f"Vach ra phai x >= {exit_min:+.2f} m (diem mat ID som nhat {max(all_last):+.2f} + {CAR_LEN_M})")
    if entry_max > exit_min:
        print("=> KHONG ton tai vach (mien vao nam ben trai mien ra).")
        return 1
    print(f"=> Mien kha dung: [{exit_min:+.2f}, {entry_max:+.2f}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

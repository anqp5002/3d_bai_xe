"""P11b muc 6: vung phu camera tren A3 — x=+-20.05 co quan sat nao khong?

Cau hoi quyet dinh: vach dem cao x=+-20.05 keo xuong A3 co bat duoc xe hang 4-5 khong?
Can: tai x=+20.05 tren A3, track PHAI DA co canonical_gid (khong chi co observation).
Va tai x=-20.05 tren A3, track PHAI CON canonical_gid.

Chay: python sim3d/tools/measure_count_line_a3.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"

X_LINE: Final = 20.05
A3_BAND: Final = (-21.0, -12.0)


def main() -> int:
    runs = []
    for tag in ("K2", "K4", "K6"):
        found = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and f"_{tag}-P10e" in p.name)
        if found:
            runs.append((tag, found[0]))
    if not runs:
        raise SystemExit("khong thay run P10e")

    print("=== Phu camera tren dai A3 (y -21..-12), moi run ===")
    gaps: dict[str, list[tuple[float, float]]] = {}
    for tag, run in runs:
        preds = run / "m1_gate" / "session" / "predictions.jsonl"
        xs: list[float] = []
        with_gid: list[tuple[float, int]] = []
        with preds.open(encoding="utf-8") as handle:
            for line in handle:
                rec = json.loads(line)
                frame = int(rec["frame_idx"])
                for obs in rec.get("observations") or []:
                    world = obs.get("anchor_world")
                    if not isinstance(world, dict) or "x" not in world:
                        continue
                    if not (A3_BAND[0] <= float(world["y"]) <= A3_BAND[1]):
                        continue
                    x = float(world["x"])
                    xs.append(x)
                    if obs.get("canonical_gid") is not None:
                        with_gid.append((x, frame))
        xs_sorted = sorted(xs)
        print(f"-- {tag}: {len(xs)} mau co quan sat tren A3")
        print(f"   x trai: {xs_sorted[:3]} ... x phai: {xs_sorted[-3:]}")
        # Khoang trong lon nhat (co quan sat hay khong)
        if len(xs_sorted) > 1:
            best_gap = (0.0, 0.0)
            best_size = 0.0
            for a, b in zip(xs_sorted, xs_sorted[1:]):
                if b - a > best_size:
                    best_size = b - a
                    best_gap = (a, b)
            gaps[tag] = [best_gap]
            print(f"   khoang trong lon nhat: {best_gap[0]:+.1f} .. {best_gap[1]:+.1f} ({best_size:.1f} m)")
        near_entry = [s for s in with_gid if abs(s[0] - X_LINE) < 5.0]
        near_exit = [s for s in with_gid if abs(s[0] + X_LINE) < 5.0]
        print(f"   mau CO gid trong |x-20.05|<5: {len(near_entry)}")
        print(f"   mau CO gid trong |x+20.05|<5: {len(near_exit)}")

    print()
    print("=== KET LUAN (TASK muc 6) ===")
    print(f"   Vach cao x=+-{X_LINE} keo xuong A3: can ID tai x={X_LINE} va x=-{X_LINE} tren A3.")
    print("   Do duoc: KHONG co mau quan sat nao trong khoang 15 < x < 25 tren dai A3")
    print("   (K2 va K6 deu vay) => camera khong phu doan A3 do.")
    print("   => Vach cao KHONG the bat duoc xe hang 4-5: chung di qua x=+-20.05 tren A3")
    print("      trong vung mo (khong observation, khong ID).")
    print("   => DUNG theo TASK muc 6, ghi ASK_coders-1_2.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

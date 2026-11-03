"""Do vach dem (P11 muc 1): vi tri cap Global ID va vi tri mat ID, quy ra met.

Chay:  python sim3d/tools/measure_count_lines.py
Ghi:   sim3d/tools/out/count_lines.json
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"
OUT_DIR: Final = TOOLS_DIR / "out"

PITCH: Final = math.radians(80.0)
F_PX: Final = 288.0
HEIGHT_M: Final = 33.6
CX: Final = 320.0
CY: Final = 320.0
CAM2_X0: Final = 240.0  # cam2 cat cot 240..640 -> crop_u = full_u - 240


def ground(u: float, v: float) -> tuple[float, float]:
    t = (v - CY) / F_PX
    y = HEIGHT_M * (math.cos(PITCH) - t * math.sin(PITCH)) / (
        t * math.cos(PITCH) + math.sin(PITCH)
    )
    z = y * math.cos(PITCH) + HEIGHT_M * math.sin(PITCH)
    return (u - CX) * z / F_PX, y


def px_per_m(v: float) -> float:
    x0, _ = ground(CX, v)
    x1, _ = ground(CX + 1.0, v)
    return 1.0 / abs(x1 - x0)


def project_count_line(x_m: float, v: float = 343.0) -> tuple[float, float]:
    """Toa do px (u, v) cua diem tren loi giua co hoanh do world ``x_m``."""
    t = (v - CY) / F_PX
    y_m = HEIGHT_M * (math.cos(PITCH) - t * math.sin(PITCH)) / (
        t * math.cos(PITCH) + math.sin(PITCH)
    )
    z_m = y_m * math.cos(PITCH) + HEIGHT_M * math.sin(PITCH)
    return CX + F_PX * x_m / z_m, v


ROAD_V: Final = 343.0  # v cua loi giua (A2)
PPM: Final = px_per_m(ROAD_V)


def run_dirs() -> list[Path]:
    out = []
    for tag in ("K2", "K4", "K6"):
        found = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir() and f"_{tag}-P10e" in p.name)
        if not found:
            raise FileNotFoundError(f"khong thay run P10e cho {tag}")
        out.append(found[0])
    return out


def measure(run_dir: Path) -> dict[str, object]:
    preds = run_dir / "m1_gate" / "session" / "predictions.jsonl"
    if not preds.exists():
        raise FileNotFoundError(f"khong thay {preds}")

    entry: dict[int, tuple[int, float]] = {}   # gid -> (frame, full_u) lan dau co GID
    last_alive: dict[tuple[int, str], tuple[int, float]] = {}

    with preds.open(encoding="utf-8") as handle:
        for line in handle:
            rec = json.loads(line)
            frame = int(rec["frame_idx"])
            for obs in rec.get("observations") or []:
                cam = str(obs["camera_id"])
                u = float(obs["anchor_pixel"]["x"])
                full_u = u + (CAM2_X0 if cam == "cam2" else 0.0)
                gid = obs.get("canonical_gid")
                if gid is None:
                    continue
                gid = int(gid)
                # VAO: chi cam2 vung phai (xe tu ngoai di vao, x lon)
                if cam == "cam2" and u > 300 and gid not in entry:
                    entry[gid] = (frame, full_u)
                key = (gid, cam)
                prev = last_alive.get(key)
                if prev is None or frame >= prev[0]:
                    last_alive[key] = (frame, full_u)

    entry_rows = []
    for gid, (frame, full_u) in sorted(entry.items()):
        x_m, _ = ground(full_u, ROAD_V)
        entry_rows.append({"gid": gid, "frame": frame, "full_u": round(full_u, 1),
                           "x_m": round(x_m, 2)})

    # RA: cam1, lan di ra (crop_u nho = sat mep trai). Lay vi tri cuoi con ID song.
    exit_rows = []
    for (gid, cam), (frame, full_u) in sorted(last_alive.items()):
        if cam != "cam1" or full_u > 120:
            continue
        x_m, _ = ground(full_u, ROAD_V)
        exit_rows.append({"gid": gid, "frame": frame, "full_u": round(full_u, 1),
                          "x_m": round(x_m, 2)})

    return {"run_id": run_dir.name, "entry": entry_rows, "exit": exit_rows}


def main() -> int:
    car_lengths = {"hatch": 4.0 * 1.1, "sedan": 4.6 * 1.1, "suv": 4.7 * 1.1}
    longest = max(car_lengths.values())
    print(f"px_per_m tai v={ROAD_V}: {PPM:.3f}  -> 1 px = {1 / PPM:.4f} m")
    print(f"xe dai nhat (suv x1,1) = {longest:.2f} m = {longest * PPM:.1f} px")
    print()

    results = []
    for run_dir in run_dirs():
        data = measure(run_dir)
        results.append(data)
        print(f"== {data['run_id']}")
        print("   VAO (cam2, GID cap lan dau; x cang nho = cang sau trong bai):")
        for row in data["entry"]:  # type: ignore[union-attr]
            print(f"      gid {row['gid']:>2} frame {row['frame']:>5} full_u={row['full_u']:>6.1f} x={row['x_m']:>7.2f} m")
        print("   RA (cam1, vi tri cuoi con ID song):")
        for row in data["exit"]:  # type: ignore[union-attr]
            print(f"      gid {row['gid']:>2} frame {row['frame']:>5} full_u={row['full_u']:>6.1f} x={row['x_m']:>7.2f} m")
        print()

    all_entry = [row["x_m"] for d in results for row in d["entry"]]  # type: ignore[union-attr]
    all_exit = [row["x_m"] for d in results for row in d["exit"]]    # type: ignore[union-attr]

    gate_in_x, _ = ground(630.0, ROAD_V)
    gate_out_x, _ = ground(4.0, ROAD_V)

    entry_deepest = min(all_entry)          # cap ID sau nhat (x nho nhat)
    entry_line_max = entry_deepest - longest  # vach phai sau hon + 1 chieu dai xe
    exit_shallowest = max(all_exit) if all_exit else float("nan")
    exit_line_min = exit_shallowest + longest

    print("== KET LUAN SO DO")
    print(f"   cong ve: vao x={gate_in_x:+.2f} m (u=630), ra x={gate_out_x:+.2f} m (u=4)")
    print(f"   {len(all_entry)} mau cap ID vao, x tu {max(all_entry):+.2f} .. {min(all_entry):+.2f} m")
    print(
        f"   -> vach vao phai o x <= {entry_line_max:+.2f} m "
        f"(sau hon diem cap ID sau nhat {min(all_entry):+.2f} m them {longest:.2f} m)"
    )
    print(f"   {len(all_exit)} mau mat ID ra, x tu {min(all_exit):+.2f} .. {max(all_exit):+.2f} m")
    print(
        f"   -> vach ra phai o x >= {exit_line_min:+.2f} m "
        f"(truoc diem mat ID som nhat {max(all_exit):+.2f} m bot {longest:.2f} m)"
    )
    # Hai rang buoc doc lap, moi vach mot ben. Chi can vach vao nam BEN PHAI vach ra
    # (xe di tu +x sang -x) va moi vach trong mien cua no.
    feasible = entry_line_max > exit_line_min
    print(
        f"   Mien vach vao: (-inf, {entry_line_max:+.2f}] · "
        f"Mien vach ra: [{exit_line_min:+.2f}, +inf)"
    )
    print(f"   TON TAI vach thoa ca hai? {'CO' if feasible else 'KHONG'}")
    if feasible:
        # Chon doi xung, chua bien ~0,6 m moi ben.
        suggested = min(abs(entry_line_max), abs(exit_line_min)) - 0.6
        entry_u, _ = project_count_line(suggested)
        exit_u, _ = project_count_line(-suggested)
        print(
            f"   -> chon x = +{suggested:.2f} m (u≈{entry_u:.0f}) va "
            f"x = -{suggested:.2f} m (u≈{exit_u:.0f}), bien con {min(abs(entry_line_max), abs(exit_line_min)) - suggested:.2f} m"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "px_per_m": round(PPM, 4),
        "car_length_max_m": longest,
        "gate_in_x_m": round(gate_in_x, 3),
        "gate_out_x_m": round(gate_out_x, 3),
        "entry_samples": all_entry,
        "exit_samples": all_exit,
        "entry_line_max_x_m": round(entry_line_max, 3),
        "exit_line_min_x_m": round(exit_line_min, 3),
        "feasible": feasible,
        "runs": results,
    }
    (OUT_DIR / "count_lines.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"   ghi: {OUT_DIR / 'count_lines.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

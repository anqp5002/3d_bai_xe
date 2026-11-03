"""Viết tài liệu thiết kế 3 bộ kịch bản tải từ dòng thời gian engine thật.

Đầu vào: ``sim3d/tools/out/load_timeline/*.json`` (do ``src/sim/loadSuites.test.ts`` sinh).
Đầu ra: ``sim3d/KICH_BAN_TAI.md``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TIMELINE = ROOT / "tools" / "out" / "load_timeline"
OUT = ROOT / "KICH_BAN_TAI.md"
FPS = 25

SUITE_TITLE = {
    "A": ("Bộ A — Cao điểm vào", "Bãi trống, xe vào dồn dập với tải tăng dần. Đo: phát hiện + cấp mã khi nhiều xe nối đuôi qua cổng, đếm vào, occupancy khi bãi lấp nhanh."),
    "B": ("Bộ B — Ra vào liên tục", "Bãi có sẵn xe, xe mới vào đỗ ngắn rồi ra, xe đỗ sẵn rời dần. Đo: đếm vào/ra đồng thời, giữ mã xe đỗ rồi rời, occupancy đổi liên tục."),
    "C": ("Bộ C — Tải lớn + điều kiện khó", "Tải kiểu bộ B dưới mây, mưa, đêm, sương, nhiễu camera, đổi thời tiết giữa video. Đo: độ bền của toàn bộ chỉ số khi ảnh xấu."),
}
WEATHER_VI = {"sun": "nắng", "cloud": "mây", "rain": "mưa", "fog": "sương"}
MODEL_VI = {"sedan": "sedan", "suv": "SUV", "hatch": "hatchback"}
COLOR_VI = {"white": "trắng", "black": "đen", "silver": "bạc", "gray": "xám", "red": "đỏ",
            "blue": "xanh dương", "green": "xanh lá", "sand": "cát"}
NOISE_VI = {"shake": "rung", "grain": "hạt", "jpeg": "JPEG", "downscale": "giảm phân giải", "fps_drop": "rớt khung",
            "flare": "lóa", "drops": "giọt nước", "smudge": "vết bẩn", "white_balance": "lệch cân bằng trắng"}


def ts(frame: int | None) -> str:
    if frame is None:
        return "—"
    s = frame / FPS
    return f"{int(s // 60):02d}:{s % 60:04.1f}"


def env_at(env: dict[str, Any], t_s: float) -> str:
    keys = sorted(env["keyframes"], key=lambda k: k["t_s"])
    prev = keys[0]
    nxt = None
    for key in keys:
        if key["t_s"] <= t_s:
            prev = key
        elif nxt is None:
            nxt = key
    hour = prev["hour"]
    if nxt is not None and nxt["t_s"] > prev["t_s"]:
        a = (t_s - prev["t_s"]) / (nxt["t_s"] - prev["t_s"])
        hour = prev["hour"] + a * (nxt["hour"] - prev["hour"])
    h = int(hour)
    m = int(round((hour - h) * 60))
    return f"{h:02d}:{m:02d} {WEATHER_VI[prev['weather']]} {prev['intensity']:.2f}"


def env_line(env: dict[str, Any]) -> str:
    parts = []
    for key in sorted(env["keyframes"], key=lambda k: k["t_s"]):
        extra = []
        if key.get("wet"):
            extra.append(f"ướt {key['wet']}")
        if key.get("fog"):
            extra.append(f"sương {key['fog']}")
        h = int(key["hour"])
        m = int(round((key["hour"] - h) * 60))
        parts.append(f"giây {key['t_s']}: {h:02d}:{m:02d} {WEATHER_VI[key['weather']]} {key['intensity']}"
                     + (f" ({', '.join(extra)})" if extra else ""))
    return "; ".join(parts)


def summarize(data: dict[str, Any]) -> dict[str, Any]:
    cars = data["cars"]
    new = [c for c in cars if not c["initial"]]
    enter = [c["first"].get("entering") for c in new if c["first"].get("entering") is not None]
    exits = [c["first"]["exited"] for c in cars if c["first"].get("exited") is not None]
    moving = [0] * (data["duration_frames"] + 2)
    for c in cars:
        f = c["first"]
        for a, b in ((f.get("entering"), f.get("parked")), (f.get("leaving_slot"), f.get("exited"))):
            if a is not None:
                end = b if b is not None else data["duration_frames"]
                for x in range(a, end):
                    moving[x] += 1
    occ = 0
    peak_occ = data["n_initial"]
    occupied_delta = [0] * (data["duration_frames"] + 2)
    for c in cars:
        if c["initial"]:
            occupied_delta[0] += 1
        elif c["first"].get("parked") is not None:
            occupied_delta[c["first"]["parked"]] += 1
        if c["first"].get("leaving_slot") is not None:
            occupied_delta[c["first"]["leaving_slot"]] -= 1
    for x in range(len(occupied_delta)):
        occ += occupied_delta[x]
        peak_occ = max(peak_occ, occ)
    minutes = data["duration_frames"] / FPS / 60
    return {
        "n_new": len(new),
        "n_enter": len(enter),
        "n_exit": len(exits),
        "n_exit_initial": sum(1 for c in cars if c["initial"] and c["first"].get("exited") is not None),
        "peak_moving": max(moving),
        "peak_occ": peak_occ,
        "end_occ": occ,
        "events_per_min": (len(enter) + len(exits)) / minutes,
    }


def main() -> None:
    only = tuple(sys.argv[1:])  # ví dụ: A  -> chỉ bộ A
    files = [p for p in sorted(TIMELINE.glob("*.json")) if not only or p.name.startswith(only)]
    datas = [json.loads(p.read_text(encoding="utf-8")) for p in files]
    out: list[str] = []
    out.append("# 3 bộ kịch bản tải lớn cho SIM3D (A, B, C)\n")
    out.append("Mục đích: lấy số liệu TechGAR khi **nhiều xe ra vào liên tục**. Mỗi kịch bản là một file "
               "`data/templates/<mã>.sim3d.json`. Trên web, chọn mẫu ở ô **Nạp mẫu**, rồi bấm **Xuất** "
               "(hoặc quay màn hình).\n")
    out.append("**Mọi thời điểm dưới đây là kết quả chạy engine thật**, không phải ước lượng. Engine tất định "
               "theo seed, nên video xuất ra sẽ khớp đúng bảng này. Đã kiểm mọi kịch bản trong tài liệu này:\n"
               "- 0 va chạm, 0 xe kẹt, 0 xe bỏ hàng chờ;\n"
               "- 0 xe bị từ chối (hết ô hoặc không có đường);\n"
               "- mọi xe chạy xong trước khi hết video.\n")
    out.append("Cách đọc cột thời gian (mm:ss tính từ đầu video, 25 fps; frame = giây × 25):\n"
               "- **Xuất hiện**: xe được tạo, xếp hàng ngoài cổng;\n"
               "- **Vào**: bắt đầu chạy vào bãi qua cổng vào;\n"
               "- **Đỗ xong**: dừng hẳn trong ô;\n"
               "- **Rời ô**: bắt đầu lùi ra;\n"
               "- **Ra**: đã ra khỏi bãi qua cổng ra.\n")
    out.append("Mốc chính xác theo frame (`gate_in_frame`, `parked_frame`, `depart_frame`, `gate_out_frame`) "
               "nằm trong `gt_events.csv` của mỗi lần xuất. Mã xe trong bảng trùng mã xe trong GT.\n")
    out.append("Lưu ý đếm cổng: chỉ 27/100 ô có lộ trình cắt vạch đếm trong tầm camera (`data/lot/count_slots.json`). "
               "Đếm cổng nên so với `gt_gate_ideal.csv` (dòng `visible=1`), không so tổng số xe.\n")

    out.append("## Tổng quan\n")
    out.append("| Mã | Tên | Dài | Đỗ sẵn | Xe mới vào | Xe ra | Lượt vào+ra/phút | Xe chạy cùng lúc (max) | Ô có xe (max) | Thời tiết | Nhiễu |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    sums = {}
    for d in datas:
        s = summarize(d)
        sums[d["id"]] = s
        noise = ", ".join(f"{NOISE_VI[k]} {v['level']}" for k, v in d["noise"].items() if isinstance(v, dict) and v.get("on")) or "không"
        w = sorted({WEATHER_VI[k["weather"]] for k in d["env"]["keyframes"]})
        out.append(f"| {d['id'].split('_')[0]} | {d['name']} | {ts(d['duration_frames'])} | {d['n_initial']} | {s['n_enter']} | "
                   f"{s['n_exit']} | {s['events_per_min']:.1f} | {s['peak_moving']} | {s['peak_occ']} | {', '.join(w)} | {noise} |")
    out.append("")

    for suite in [x for x in ("A", "B", "C") if any(d["id"].startswith(x) for d in datas)]:
        title, desc = SUITE_TITLE[suite]
        out.append(f"## {title}\n\n{desc}\n")
        for d in [x for x in datas if x["id"].startswith(suite)]:
            s = sums[d["id"]]
            out.append(f"### {d['name']} (`{d['id']}.sim3d.json`)\n")
            out.append(f"{d['description']}\n")
            out.append(f"- Dài {ts(d['duration_frames'])} ({d['duration_frames']} frame).")
            out.append(f"- Đỗ sẵn {d['n_initial']} xe, {s['n_exit_initial']} xe trong số đó rời đi.")
            out.append(f"- {s['n_enter']} xe mới vào; tổng {s['n_exit']} lượt ra.")
            out.append(f"- Đỉnh {s['peak_moving']} xe chạy cùng lúc; đỉnh {s['peak_occ']} ô có xe; cuối video {s['end_occ']} ô có xe.")
            out.append(f"- Môi trường: {env_line(d['env'])}.")
            noise = ", ".join(f"{NOISE_VI[k]} {v['level']}" for k, v in d["noise"].items() if isinstance(v, dict) and v.get("on"))
            out.append(f"- Nhiễu camera: {noise or 'tắt'}.\n")
            out.append("| Mã xe | Loại | Màu | Ô | Xuất hiện | Vào | Đỗ xong | Rời ô | Ra | Thời tiết lúc vào/rời |")
            out.append("|---|---|---|---|---|---|---|---|---|---|")
            moved = [c for c in d["cars"] if not c["initial"] or c["first"].get("leaving_slot") is not None]
            moved.sort(key=lambda c: (c["first"].get("entering", c["first"].get("leaving_slot", 0)) or 0, c["id"]))
            for c in moved:
                f = c["first"]
                appear = None if c["initial"] else min(v for k, v in f.items() if k in ("queued", "entering"))
                t_ref = f.get("entering") if not c["initial"] else f.get("leaving_slot")
                tag = " (đỗ sẵn)" if c["initial"] else ""
                out.append(f"| {c['id']}{tag} | {MODEL_VI[c['model']]} | {COLOR_VI[c['color']]} | {c['slot'] or '—'} | "
                           f"{ts(appear)} | {ts(f.get('entering'))} | {ts(f.get('parked') if not c['initial'] else None)} | "
                           f"{ts(f.get('leaving_slot'))} | {ts(f.get('exited'))} | {env_at(d['env'], (t_ref or 0) / FPS)} |")
            stay = [c for c in d["cars"] if c["initial"] and c["first"].get("leaving_slot") is None]
            if stay:
                out.append(f"\nXe đỗ sẵn không rời ({len(stay)}): " + ", ".join(f"{c['id']}@{c['slot']}" for c in stay) + ".\n")
            else:
                out.append("")
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"ghi {OUT}")


if __name__ == "__main__":
    main()

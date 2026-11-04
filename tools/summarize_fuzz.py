"""P17c — tóm tắt log fuzz 200 kịch bản thành bảng phân loại cho REPORT_P17c.md.

Đọc các file ``sim3d/tools/out/fuzz_200_s*.log`` (mỗi shard một file, do vitest in
dòng ``[fuzz <seed>] ... → ran=... stuck=...``), gộp lại rồi đếm:

- số seed đỏ / tổng;
- phân loại theo triệu chứng đầu tiên (stuck / kẹt / bỏ hàng chờ / từ chối sự kiện);
- trạng thái của xe bị kẹt (``leaving_slot@S001`` …) lấy từ dòng ``kẹt giữa chừng``;
- frame dừng sớm nhỏ nhất/lớn nhất, seed nhỏ nhất mỗi loại.

Chạy::

    python sim3d/tools/summarize_fuzz.py
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"

LINE_RE = re.compile(r"^\[fuzz (?P<seed>\d+)\] (?P<plan>.*?) → (?P<rest>.*)$")
STALL_RE = re.compile(r"(V\d+)\(([a-z_]+)(?:@(S\d+))?\)")


def parse_rest(rest: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for key in ("ran", "cars", "exited", "parked", "collisions", "stuck", "stalls",
                "stillEnd", "abandoned", "queueEnd", "rejected", "settled"):
        match = re.search(rf"\b{key}=(\S+)", rest)
        if match is not None:
            data[key] = match.group(1)
    return data


def plan_value(plan: str, key: str) -> str:
    match = re.search(rf"\b{key}=(\S+)", plan)
    return match.group(1) if match is not None else "?"


def read_log(path: Path) -> str:
    """Đọc log do PowerShell `Tee-Object` ghi: PS 5.1 ghi UTF-16LE, PS 7 ghi UTF-8."""
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig")
    return raw.decode("utf-8", errors="replace")


def main() -> int:
    logs = sorted(OUT.glob("fuzz_200_u*.log")) or sorted(OUT.glob("fuzz_200_s*.log"))
    if not logs:
        print("không thấy log fuzz_200_u*.log / fuzz_200_s*.log", file=sys.stderr)
        return 1

    seeds: dict[int, dict[str, str]] = {}
    stall_states: Counter[str] = Counter()
    stall_cars: Counter[str] = Counter()
    first_stall_seed: dict[str, int] = {}

    for log in logs:
        text = read_log(log)
        for raw in text.splitlines():
            match = LINE_RE.match(raw.strip())
            if match is None:
                continue
            seed = int(match.group("seed"))
            seeds[seed] = {"plan": match.group("plan"), **parse_rest(match.group("rest"))}
            for car, state, slot in STALL_RE.findall(match.group("rest")):
                key = f"{state}@{slot}" if slot else state
                stall_states[key] += 1
                stall_cars[key] += 1
                first_stall_seed.setdefault(key, seed)

    total = len(seeds)
    red: list[int] = []
    buckets: Counter[str] = Counter()
    per_seed: dict[str, list[int]] = {}
    ran_values: list[int] = []
    for seed in sorted(seeds):
        row = seeds[seed]
        bad: list[str] = []
        if int(row.get("collisions", "0")) > 0:
            bad.append("va chạm")
        if int(row.get("stuck", "0")) > 0:
            bad.append("stuck")
        if int(row.get("stalls", "0")) > 0:
            bad.append("kẹt giữa chừng")
        if int(row.get("stillEnd", "0")) > 0:
            bad.append("còn kẹt cuối")
        if int(row.get("abandoned", "0")) > 0:
            bad.append("bỏ hàng chờ")
        if int(row.get("queueEnd", "0")) > 0:
            bad.append("còn queued cuối")
        if int(row.get("rejected", "0")) > 0:
            bad.append("sự kiện bị từ chối")
        if bad:
            red.append(seed)
            buckets[" + ".join(bad)] += 1
            for name in bad:
                per_seed.setdefault(name, []).append(seed)
        ran = row.get("ran", "0").split("/")[0]
        if ran.isdigit():
            ran_values.append(int(ran))

    print(f"log: {', '.join(p.name for p in logs)}")
    print(f"seed chạy được: {total}")
    print(f"seed ĐỎ: {len(red)}/{total}")
    print(f"seed XANH: {total - len(red)}")
    print()
    print("phân loại theo tổ hợp triệu chứng:")
    for name, count in buckets.most_common():
        print(f"  {count:3d}  {name}")
    print()
    print("số seed có từng triệu chứng:")
    for name, values in sorted(per_seed.items(), key=lambda item: -len(item[1])):
        print(f"  {len(values):3d}  {name}: nhỏ nhất seed {min(values)}")
    print()
    print("trạng thái xe lúc phát hiện kẹt (đếm lần xuất hiện trong dòng lỗi):")
    for name, count in stall_states.most_common(10):
        print(f"  {count:4d}  {name}  (seed nhỏ nhất {first_stall_seed[name]})")
    print()
    if ran_values:
        print(f"frame dừng sớm: min {min(ran_values)} max {max(ran_values)}")
    plans = {seeds[seed]["plan"] for seed in seeds}
    print(f"kịch bản khác nhau: {len(plans)}")
    print()
    print("10 seed nặng nhất (theo stuck) và seed bãi gần trống:")
    heavy = sorted(
        seeds,
        key=lambda s: -int(seeds[s].get("stuck", "0")),
    )[:10]
    for seed in heavy:
        row = seeds[seed]
        print(
            f"  seed {seed:3d}  n_parked={plan_value(row['plan'], 'n_parked'):>2}  "
            f"n_arrivals={plan_value(row['plan'], 'n_arrivals'):>2}  "
            f"stuck={row.get('stuck', '?'):>2}  queueEnd={row.get('queueEnd', '?'):>2}  "
            f"ran={row.get('ran', '?')}"
        )
    empty = [s for s in sorted(seeds) if plan_value(seeds[s]["plan"], "n_parked") == "0"]
    for seed in empty:
        row = seeds[seed]
        print(
            f"  seed {seed:3d}  n_parked= 0  "
            f"n_arrivals={plan_value(row['plan'], 'n_arrivals'):>2}  "
            f"stuck={row.get('stuck', '?'):>2}  queueEnd={row.get('queueEnd', '?'):>2}  "
            f"ran={row.get('ran', '?')}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

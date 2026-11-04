"""Sinh 10 kịch bản DÀI (sáng/tối × 5/10/20/30/60 phút) cho đo độ ổn định — P19a.

Mục đích: kiểm engine có ổn định suốt video dài không. **Cùng một mức tải cho mọi độ dài**, nên
chỉ thời gian thay đổi — so sánh giữa các độ dài là so sánh công bằng.

Mức tải (đo bằng mô phỏng ``sim3d/tools/out/p19a_occupancy.py``, không đoán):

- 50 xe đỗ sẵn (nền), **không tự rời** — chỉ rời khi có lệnh ``leave``;
- xe vào đều **6 s/xe**, đỗ ngẫu nhiên 60–240 s rồi tự ra (luồng chính);
- mỗi **30 s** một xe nền rời đi (lấy dần);
- mỗi **30 s** một xe nền MỚI vào đỗ (bổ sung nền, đỗ tới hết video) — cần vậy để nền không cạn
  trong video 60 phút và số xe dao động ~50–80, **không bao giờ đầy** (bãi có 100 ô).

Kết quả mô phỏng (mọi độ dài): đỉnh **77–81** xe, đáy **50** xe.

Môi trường:
- **Sáng** ``L_sang_*``: 8h00 nắng 0,8 → mây nhẹ ở giữa video → nắng lại; preset E2.
- **Tối**   ``L_toi_*`` : 19h00 trời quang đêm, đèn bãi bật; preset E6.
- Không nhiễu camera (chỉ đo ảnh hưởng thời gian + ánh sáng).

Ghi ``sim3d/data/templates_long/<id>.sim3d.json``, newline LF. Không sửa ``gen_load_suites.py``.

Chạy từ gốc repo::

    python sim3d/tools/gen_long_suites.py
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_load_suites import kf  # noqa: E402
from gen_templates import (  # noqa: E402
    CAR_COLORS,
    CAR_MODELS,
    CAR_SCALE,
    DEFAULT_SPEED_KMH,
    FPS,
    LOT_NAME,
    NARROW_SLOT_WIDTH_M,
    NOISE_KINDS,
    SCHEMA,
    Mulberry32,
    load_lot,
    reachable_slots,
)

TEMPLATES_LONG_DIR = Path(__file__).resolve().parents[1] / "data" / "templates_long"

# ---- Mức tải DÙNG CHUNG cho mọi độ dài (xem docstring) ----
N_INITIAL_PARKED = 50
ARRIVE_GAP_S = 6.0
PARK_S = (60, 240)
BASE_LEAVE_GAP_S = 30.0
BASE_TOPUP_GAP_S = 30.0
SETTLE_S = 240  # dừng nhận xe mới trước khi hết video ~4 phút

DURATIONS_MIN = (5, 10, 20, 30, 60)
SEED_BASE = 7900


@dataclass(frozen=True)
class LongSpec:
    """Một kịch bản dài: id, số phút, bảng môi trường, seed."""

    id: str
    minutes: int
    env: list[dict[str, Any]]
    preset: str
    name_prefix: str
    seed: int = field(default=0)


def _morning_env(duration_s: int) -> list[dict[str, Any]]:
    """8h → 9h nắng 0,8, mây nhẹ ở giữa video rồi nắng lại."""
    mid = duration_s / 2
    span = max(60.0, duration_s / 6)
    hours_per_second = 1.0 / 3600.0  # 8h → 9h trong đúng độ dài video
    return [
        kf(0.0, 8.0, "sun", 0.8),
        kf(max(1.0, mid - span / 2), 8.0 + (mid - span / 2) * hours_per_second, "cloud", 0.55),
        kf(mid + span / 2, 8.0 + (mid + span / 2) * hours_per_second, "sun", 0.8),
    ]


def _evening_env(duration_s: int) -> list[dict[str, Any]]:
    """19h → 20h trời quang, đêm, đèn bãi (weather `sun` = trời quang nhưng hour = 19–20)."""
    hours_per_second = 1.0 / 3600.0
    return [
        kf(0.0, 19.0, "sun", 0.8),
        kf(duration_s, 19.0 + duration_s * hours_per_second, "sun", 0.8),
    ]


def build_specs() -> list[LongSpec]:
    specs: list[LongSpec] = []
    for index, minutes in enumerate(DURATIONS_MIN):
        specs.append(
            LongSpec(
                id=f"L_sang_{minutes:02d}",
                minutes=minutes,
                env=_morning_env(minutes * 60),
                preset="E2",
                name_prefix="Sáng",
                seed=SEED_BASE + index,
            )
        )
    for index, minutes in enumerate(DURATIONS_MIN):
        specs.append(
            LongSpec(
                id=f"L_toi_{minutes:02d}",
                minutes=minutes,
                env=_evening_env(minutes * 60),
                preset="E6",
                name_prefix="Tối",
                seed=SEED_BASE + 100 + index,
            )
        )
    return specs


def build(spec: LongSpec, lot: dict[str, Any]) -> dict[str, Any]:
    duration_s = spec.minutes * 60
    arrive_end = duration_s - SETTLE_S
    rng = Mulberry32(spec.seed)
    slots = reachable_slots(lot)
    order = rng.shuffle(list(slots))

    # Xe đỗ sẵn ban đầu (nền). KHÔNG đặt park_s -> đỗ tới khi có lệnh rời.
    placement: list[dict[str, Any]] = []
    for index, slot in enumerate(order[:N_INITIAL_PARKED]):
        narrow = float(slot.get("width_m", 9.0)) < NARROW_SLOT_WIDTH_M
        placement.append(
            {
                "slot": slot["id"],
                "car_id": f"V{index + 1:03d}",
                "model": "hatch" if narrow else rng.choice(CAR_MODELS),
                "color": rng.choice(CAR_COLORS),
            }
        )

    events: list[dict[str, Any]] = []
    frame_of = lambda t: round(t * FPS)  # noqa: E731

    # Xe nền rời dần + xe nền mới vào bổ sung (mỗi 30 s một xe).
    t = BASE_LEAVE_GAP_S
    while t <= arrive_end:
        events.append({"frame": frame_of(t), "type": "leave", "params": {"car_id": ""}})
        t += BASE_LEAVE_GAP_S
    t = BASE_TOPUP_GAP_S
    while t <= arrive_end:
        events.append(
            {
                "frame": frame_of(t),
                "type": "add_car",
                "params": {
                    "slot": "random_free",
                    "speed_kmh": 9 + rng.randint(4),
                    "model": rng.choice(CAR_MODELS),
                    "color": rng.choice(CAR_COLORS),
                },
            }
        )
        t += BASE_TOPUP_GAP_S

    # Luồng chính: xe vào đều 6 s/xe, đỗ 60–240 s rồi ra.
    t = 5.0
    while t <= arrive_end:
        lo, hi = PARK_S
        events.append(
            {
                "frame": frame_of(t),
                "type": "add_car",
                "params": {
                    "slot": "random_free",
                    "speed_kmh": 9 + rng.randint(4),
                    "model": rng.choice(CAR_MODELS),
                    "color": rng.choice(CAR_COLORS),
                    "park_s": round(lo + rng.random() * (hi - lo)),
                },
            }
        )
        t += ARRIVE_GAP_S

    # `leave` cần car_id của xe ĐANG ĐỖ. Gán vòng: lấy lần lượt xe nền theo thứ tự tất định.
    leavers = [car["car_id"] for car in placement]
    leave_events = [event for event in events if event["type"] == "leave"]
    for index, event in enumerate(leave_events):
        event["params"]["car_id"] = leavers[index % len(leavers)]

    events.sort(key=lambda e: (e["frame"], 0 if e["type"] == "leave" else 1))

    noise: dict[str, Any] = {kind: {"on": False, "level": 0.5} for kind in NOISE_KINDS}
    noise["seed"] = spec.seed

    return {
        "schema": SCHEMA,
        "name": f"{spec.name_prefix} {spec.minutes} phút (ổn định)",
        "description": (
            f"Kịch bản dài {spec.minutes} phút để đo độ ổn định: 50 xe đỗ sẵn, xe vào mỗi 6 s "
            f"(đỗ 60–240 s rồi ra), mỗi 30 s một xe đỗ sẵn rời và một xe mới vào bổ sung. "
            f"Tải giữ nguyên ở mọi độ dài. Không nhiễu camera."
        ),
        "lot": LOT_NAME,
        "seed": spec.seed,
        "car_scale": CAR_SCALE,
        "default_speed_kmh": DEFAULT_SPEED_KMH,
        "camera_mode": "2cam",
        "initial": {"n_parked": len(placement), "placement": placement},
        "env": {"preset": spec.preset, "keyframes": spec.env},
        "noise": noise,
        "events": events,
        "duration_frames": duration_s * FPS,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=TEMPLATES_LONG_DIR)
    parser.add_argument("--only", nargs="*", default=None, help="chỉ các id này")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    lot = load_lot()
    for spec in build_specs():
        if args.only is not None and spec.id not in args.only:
            continue
        data = build(spec, lot)
        path = args.out / f"{spec.id}.sim3d.json"
        # newline="\n" -> LF, đúng yêu cầu
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
        print(
            f"ghi {path.name}: {spec.minutes:>2} phút, "
            f"{len(data['events'])} sự kiện, {len(data['initial']['placement'])} xe đỗ sẵn"
        )


if __name__ == "__main__":
    main()

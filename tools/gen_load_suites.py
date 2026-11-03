"""Sinh 3 bộ kịch bản tải lớn (A, B, C) cho SIM3D.

Bộ A "Cao điểm vào": bãi trống, xe vào dồn dập, tăng dần tải.
Bộ B "Ra vào liên tục": bãi có xe đỗ sẵn, vừa vào vừa ra cùng lúc.
Bộ C "Tải lớn + điều kiện khó": tải kiểu bộ B dưới mây, mưa, đêm, sương, nhiễu camera.

Chạy từ gốc repo::

    python sim3d/tools/gen_load_suites.py

Ghi ``sim3d/data/templates/{A,B,C}<n>_*.sim3d.json`` (web thấy ở danh sách mẫu).
Tất định theo seed. Bảng thời gian từng xe lấy từ lần chạy engine thật:
``npx vitest run src/sim/loadSuites.test.ts`` (trong ``sim3d/web``) sinh
``sim3d/tools/out/load_timeline/*.json``, rồi ``gen_load_doc.py`` viết tài liệu.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
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

TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "data" / "templates"


@dataclass(frozen=True)
class Wave:
    """Một đợt xe vào: n xe, cách nhau gap_s giây, bắt đầu ở start_s."""

    start_s: float
    n: int
    gap_s: float
    park_s: tuple[float, float] | None  # None = đỗ tới hết video
    speed: tuple[int, int] = (9, 12)


@dataclass(frozen=True)
class Spec:
    id: str
    name: str
    description: str
    seed: int
    duration_s: int
    env: list[dict[str, Any]]
    waves: list[Wave]
    n_parked: int = 0
    # Xe đỗ sẵn rời đi: (bắt đầu giây, số xe, cách nhau giây)
    initial_leaves: list[tuple[float, int, float]] = field(default_factory=list)
    noise: dict[str, float] = field(default_factory=dict)  # kind -> level (bật)
    preset: str | None = None


def kf(t_s: float, hour: float, weather: str, intensity: float, wet: float = 0.0, fog: float = 0.0) -> dict[str, Any]:
    key: dict[str, Any] = {"t_s": t_s, "hour": hour, "weather": weather, "intensity": intensity}
    if wet:
        key["wet"] = wet
    if fog:
        key["fog"] = fog
    return key


NOON = [kf(0, 12, "sun", 0.8)]
SUITES: list[Spec] = [
    # ---------------- Bộ A: cao điểm vào ----------------
    Spec("A1_vao_deu_30", "A1 Vào đều 30 xe", "Bãi trống, 30 xe vào đều mỗi 6 s, đỗ tới hết video.",
         7101, 300, NOON, [Wave(5, 30, 6.0, None)]),
    Spec("A2_vao_day_60", "A2 Vào dày 60 xe", "Bãi trống, 60 xe vào mỗi 4 s, đỗ tới hết video.",
         7102, 480, NOON, [Wave(5, 60, 4.0, None)]),
    Spec("A3_lap_day_bai", "A3 Lấp gần đầy bãi", "Bãi trống, 85 xe vào mỗi 3,5 s (lấp ~85 % bãi).",
         7103, 780, NOON, [Wave(5, 85, 3.5, None)]),
    Spec("A4_don_dot", "A4 Dồn từng đợt", "4 đợt × 15 xe, mỗi đợt xe cách nhau 2,5 s, các đợt cách nhau 75 s.",
         7104, 480, NOON, [Wave(5 + 75 * i, 15, 2.5, None) for i in range(4)]),
    # ---------------- Bộ B: ra vào liên tục ----------------
    Spec("B1_quay_vong_vua", "B1 Quay vòng vừa", "40 xe đỗ sẵn; 40 xe vào mỗi 6 s, đỗ 40–90 s rồi ra; 12 xe đỗ sẵn rời dần.",
         7201, 420, NOON, [Wave(5, 40, 6.0, (40, 90))], n_parked=40, initial_leaves=[(20, 12, 25)]),
    Spec("B2_quay_vong_cao", "B2 Quay vòng cao", "60 xe đỗ sẵn; 60 xe vào mỗi 4 s, đỗ 30–60 s rồi ra; 20 xe đỗ sẵn rời dần.",
         7202, 480, NOON, [Wave(5, 60, 4.0, (30, 60))], n_parked=60, initial_leaves=[(10, 20, 15)]),
    Spec("B3_doi_ca", "B3 Đổi ca", "80 xe đỗ sẵn; 40 xe đỗ sẵn rời mỗi 5 s, cùng lúc 40 xe mới vào mỗi 5 s.",
         7203, 420, NOON, [Wave(15, 40, 5.0, None)], n_parked=80, initial_leaves=[(5, 40, 5)]),
    Spec("B4_on_dinh_dai", "B4 Ổn định dài", "30 xe đỗ sẵn; xe vào đều mỗi 7 s trong 8 phút, đỗ 60–120 s; 10 xe đỗ sẵn rời dần.",
         7204, 600, NOON, [Wave(5, 68, 7.0, (60, 120))], n_parked=30, initial_leaves=[(30, 10, 45)]),
    # ---------------- Bộ C: tải lớn + điều kiện khó ----------------
    Spec("C1_tai_may", "C1 Tải lớn trời mây", "Như B2 dưới trời mây dày, chiều 15h.",
         7301, 480, [kf(0, 15, "cloud", 0.8)], [Wave(5, 60, 4.0, (30, 60))], n_parked=60, initial_leaves=[(10, 20, 15)]),
    Spec("C2_tai_mua_chieu", "C2 Tải lớn mưa chiều", "Như B2, mưa chiều 16h30 cường độ tăng dần, đường ướt.",
         7302, 480, [kf(0, 16.5, "rain", 0.4, wet=0.6), kf(240, 17, "rain", 0.85, wet=0.95)],
         [Wave(5, 60, 4.0, (30, 60))], n_parked=60, initial_leaves=[(10, 20, 15)]),
    Spec("C3_tai_dem_mua", "C3 Tải lớn đêm mưa", "Như B1, đêm 21h mưa 0,75 có sương, nhiễu hạt + rung camera.",
         7303, 420, [kf(0, 21, "rain", 0.75, wet=0.95, fog=0.15)],
         [Wave(5, 40, 6.0, (40, 90))], n_parked=40, initial_leaves=[(20, 12, 25)],
         noise={"grain": 0.5, "shake": 0.3}),
    Spec("C4_chuyen_troi", "C4 Chuyển trời giữa video", "Như B2, nắng 15h → mây → mưa → chạng vạng mưa, nhiễu JPEG + giọt nước.",
         7304, 480, [kf(0, 15, "sun", 0.8), kf(120, 16, "cloud", 0.8), kf(240, 17, "rain", 0.7, wet=0.8),
                     kf(400, 18.3, "rain", 0.6, wet=0.95, fog=0.1)],
         [Wave(5, 60, 4.0, (30, 60))], n_parked=60, initial_leaves=[(10, 20, 15)],
         noise={"jpeg": 0.4, "drops": 0.4}),
]


def build(spec: Spec, lot: dict[str, Any]) -> dict[str, Any]:
    rng = Mulberry32(spec.seed)
    slots = reachable_slots(lot)
    order = rng.shuffle(list(slots))
    placement: list[dict[str, Any]] = []
    for index, slot in enumerate(order[: spec.n_parked]):
        narrow = float(slot.get("width_m", 9.0)) < NARROW_SLOT_WIDTH_M
        model = "hatch" if narrow else rng.choice(CAR_MODELS)
        placement.append({"slot": slot["id"], "car_id": f"V{index + 1:03d}", "model": model,
                          "color": rng.choice(CAR_COLORS)})

    events: list[dict[str, Any]] = []
    for start_s, n, gap_s in spec.initial_leaves:
        leavers = rng.shuffle(list(placement))[:n]
        for i, car in enumerate(leavers):
            events.append({"frame": round((start_s + i * gap_s) * FPS), "type": "leave",
                           "params": {"car_id": car["car_id"]}})
    for wave in spec.waves:
        for i in range(wave.n):
            params: dict[str, Any] = {
                "slot": "random_free",
                "speed_kmh": wave.speed[0] + rng.randint(wave.speed[1] - wave.speed[0] + 1),
                "model": rng.choice(CAR_MODELS),
                "color": rng.choice(CAR_COLORS),
            }
            if wave.park_s is not None:
                lo, hi = wave.park_s
                params["park_s"] = round(lo + rng.random() * (hi - lo))
            events.append({"frame": round((wave.start_s + i * wave.gap_s) * FPS), "type": "add_car", "params": params})
    events.sort(key=lambda e: (e["frame"], 0 if e["type"] == "leave" else 1))

    noise: dict[str, Any] = {k: {"on": k in spec.noise, "level": spec.noise.get(k, 0.5)} for k in NOISE_KINDS}
    noise["seed"] = spec.seed
    return {
        "schema": SCHEMA,
        "name": spec.name,
        "description": spec.description,
        "lot": LOT_NAME,
        "seed": spec.seed,
        "car_scale": CAR_SCALE,
        "default_speed_kmh": DEFAULT_SPEED_KMH,
        "camera_mode": "2cam",
        "initial": {"n_parked": len(placement), "placement": placement},
        "env": {"preset": spec.preset, "keyframes": spec.env},
        "noise": noise,
        "events": events,
        "duration_frames": spec.duration_s * FPS,
    }


def main() -> None:
    lot = load_lot()
    for spec in SUITES:
        path = TEMPLATES_DIR / f"{spec.id}.sim3d.json"
        path.write_text(json.dumps(build(spec, lot), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"ghi {path.name}")


if __name__ == "__main__":
    main()

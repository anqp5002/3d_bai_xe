"""Sinh 8 kịch bản mẫu K1–K8 (FE §5, dòng 88) — tất định theo seed cố định.

Chạy từ gốc repo::

    python sim3d/tools/gen_templates.py

Script đọc ``sim3d/data/lot/lot_pucpr.json`` (chỉ **đọc**, không sửa) để lấy các ô
``reachable`` và ghi đè ``sim3d/data/templates/K{1..8}.sim3d.json``. Cùng một lot →
cùng byte trên đĩa; sau P2b chạy lại là đủ.

Bốc ngẫu nhiên dùng **mulberry32** tự cài (giống ``sim/rng.ts``) thay vì ``random``
của Python, để kết quả không phụ thuộc phiên bản Python và dễ đối chiếu với sim.

Quy ước D4 (C5): ``car_scale = 1,10`` trong kịch bản; hệ số thực của từng ô do
engine tính ``min(1,10, (w_ô − 0,35) / w_xe)``. File mẫu **không** ghi ``scale`` vào
``initial.placement`` vì validator (`contracts/scenario.ts`) chỉ nhận 1,00–1,30, còn
hệ số thực có thể < 1,0 ở ô hẹp. Ô hẹp < 2,10 m chỉ nhận hatchback (D4).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------------------
# Hằng số hợp đồng (đồng bộ `sim3d/web/src/contracts/sim.ts`, `scenario.ts`, `events.ts`)
# --------------------------------------------------------------------------------------
SCHEMA = 1
LOT_NAME = "pucpr"
FPS = 25

CAR_SCALE = 1.10
CAR_SCALE_MIN = 1.0
CAR_SCALE_MAX = 1.3
SLOT_EDGE_MARGIN_M = 0.35
NARROW_SLOT_WIDTH_M = 2.1
DEFAULT_SPEED_KMH = 10
SPEED_MIN_KMH = 5
SPEED_MAX_KMH = 20

CAR_MODELS = ("sedan", "suv", "hatch")
CAR_COLORS = ("white", "black", "silver", "gray", "red", "blue", "green", "sand")
#: [dài, rộng, cao] m (C4) — chỉ dùng bề rộng cho D4.
CAR_DIMENSIONS_M: dict[str, tuple[float, float, float]] = {
    "sedan": (4.6, 1.8, 1.45),
    "suv": (4.7, 1.9, 1.7),
    "hatch": (4.0, 1.75, 1.5),
}
NOISE_KINDS = (
    "shake",
    "grain",
    "jpeg",
    "downscale",
    "fps_drop",
    "flare",
    "drops",
    "smudge",
    "white_balance",
)
CAMERA_MODES = ("1cam", "2cam")
WEATHERS = ("sun", "cloud", "rain", "fog")
EVENT_TYPES = (
    "add_car",
    "add_cars",
    "leave",
    "leave_random",
    "set_speed",
    "env_keyframe",
    "noise",
)

#: Tên + mô tả (khớp `sim3d/server/sim3d_server/config.py:TEMPLATE_DEFAULTS`).
TEMPLATE_INFO: dict[str, tuple[str, str]] = {
    "K1": ("Xe đơn", "1 xe vào, đỗ 15 s, ra, E1"),
    "K2": ("Đồng thời", "3 xe vào cách 2 s, có cặp cùng màu, E3"),
    "K3": ("Ra–vào chéo", "Xe đỗ sẵn rời đúng lúc xe mới vào lối"),
    "K4": ("Hàng chờ cổng", "6 xe dồn cổng"),
    "K5": ("Cả ngày", "E2, 20 chu trình rải đều"),
    "K6": ("Đêm mưa", "E8, 8 chu trình"),
    "K7": ("Bãi đầy", "90 xe đỗ sẵn, 5 xe ra/vào"),
    "K8": ("Tĩnh kiểm thu", "30 xe, E1, không sự kiện, 20 s"),
}

#: Seed cố định của từng mẫu (đổi seed là đổi file — cần lead duyệt).
TEMPLATE_SEED: dict[str, int] = {
    "K1": 9001,
    "K2": 9002,
    "K3": 9003,
    "K4": 9004,
    "K5": 9005,
    "K6": 9006,
    "K7": 9007,
    "K8": 9008,
}

SIM3D_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = SIM3D_ROOT / "data"
LOT_PATH = DATA_ROOT / "lot" / "lot_pucpr.json"
TEMPLATES_DIR = DATA_ROOT / "templates"

_MASK32 = 0xFFFFFFFF


# --------------------------------------------------------------------------------------
# RNG mulberry32 (cùng thuật toán với `sim/rng.ts`)
# --------------------------------------------------------------------------------------
class Mulberry32:
    """Sinh số [0, 1) tất định theo seed 32-bit, không dùng ``random`` của Python."""

    def __init__(self, seed: int) -> None:
        if not isinstance(seed, int) or not 0 <= seed <= _MASK32:
            raise ValueError(f"seed phải là số nguyên 0…2^32-1, nhận {seed!r}")
        self.state = seed

    def next_u32(self) -> int:
        self.state = (self.state + 0x6D2B79F5) & _MASK32
        value = self.state
        value = (value ^ (value >> 15)) & _MASK32
        value = (value * (value | 1)) & _MASK32
        inner = ((value ^ (value >> 7)) * (value | 61)) & _MASK32
        value = (value ^ ((value + inner) & _MASK32)) & _MASK32
        return (value ^ (value >> 14)) & _MASK32

    def random(self) -> float:
        return self.next_u32() / 4_294_967_296.0

    def randint(self, max_exclusive: int) -> int:
        if not isinstance(max_exclusive, int) or max_exclusive < 1:
            raise ValueError(f"randint cần max_exclusive ≥ 1, nhận {max_exclusive!r}")
        return min(max_exclusive - 1, int(self.random() * max_exclusive))

    def choice(self, items: tuple[str, ...] | list[str]) -> str:
        if not items:
            raise ValueError("choice: danh sách rỗng")
        return items[self.randint(len(items))]

    def shuffle(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        values = list(items)
        for index in range(len(values) - 1, 0, -1):
            swap = self.randint(index + 1)
            values[index], values[swap] = values[swap], values[index]
        return values


# --------------------------------------------------------------------------------------
# Đọc lot
# --------------------------------------------------------------------------------------
def load_lot(path: Path = LOT_PATH) -> dict[str, Any]:
    """Đọc ``lot_pucpr.json`` đã có; thiếu/sai cấu trúc là lỗi rõ ràng (R2)."""
    if not path.is_file():
        raise FileNotFoundError(f"chưa có lot: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("slots"), list):
        raise ValueError(f"{path}: thiếu mảng slots")
    return data


#: O den duoc cong = o ma lo trinh vao/ra chi cat vach dem dung 1 lan (ANS_17 / P11c).
#: File do `web/src/export/countSlots.test.ts` sinh tu lo trinh THUC; o ngoai danh sach nay
#: bi co `gate_note` (lo trinh vong qua tam bai hoac camera khong phu A3) => GT rong cot cong.
COUNT_SLOTS_PATH = DATA_ROOT / "lot" / "count_slots.json"


def countable_slot_ids() -> set[str]:
    """Ma cac o dem duoc cong (doc `data/lot/count_slots.json`).

    Khong hard-code so hang: danh sach do lo trinh sinh ra, nen doi dinh tuyen la danh sach
    doi theo va template sinh lai se bam dung.
    """
    if not COUNT_SLOTS_PATH.exists():
        raise FileNotFoundError(
            f"thieu {COUNT_SLOTS_PATH} — chay "
            "`cd sim3d/web && npx vitest run src/export/countSlots.test.ts` truoc"
        )
    payload = json.loads(COUNT_SLOTS_PATH.read_text(encoding="utf-8"))
    valid = payload.get("valid")
    if not isinstance(valid, list) or not valid:
        raise ValueError(f"{COUNT_SLOTS_PATH}: khoa 'valid' phai la list khong rong")
    ids = {str(item) for item in valid}
    unknown = sorted(item for item in ids if not _is_slot_id(item))
    if unknown:
        raise ValueError(f"{COUNT_SLOTS_PATH}: ma o khong hop le: {unknown}")
    return ids


def reachable_slots(lot: dict[str, Any]) -> list[dict[str, Any]]:
    """Các ô ``reachable is True``, đúng mã S001–S100, không trùng."""
    slots: list[dict[str, Any]] = []
    seen: set[str] = set()
    for slot in lot["slots"]:
        if not isinstance(slot, dict) or slot.get("reachable") is not True:
            continue
        slot_id = slot.get("id")
        if not isinstance(slot_id, str) or not _is_slot_id(slot_id):
            raise ValueError(f"lot có ô không hợp lệ: {slot_id!r}")
        if slot_id in seen:
            raise ValueError(f"lot có ô trùng: {slot_id}")
        seen.add(slot_id)
        slots.append(slot)
    if not slots:
        raise ValueError("lot không có ô reachable nào")
    return slots


def _is_slot_id(value: str) -> bool:
    if len(value) != 4 or value[0] != "S" or not value[1:].isdigit():
        return False
    number = int(value[1:])
    return 1 <= number <= 100


# --------------------------------------------------------------------------------------
# Chọn ô / mẫu xe / màu
# --------------------------------------------------------------------------------------
def _spread_slots(
    lot: dict[str, Any], rng: Mulberry32, count: int, only_ids: set[str]
) -> list[dict[str, Any]]:
    """Chọn ``count`` ô đếm được nhưng **rải đều** theo trục x.

    Vì sao không dùng `_selected_slots` (bốc ngẫu nhiên): 27 ô đếm được là một dải
    liền giữa bãi, bốc ngẫu nhiên dễ ra 6 ô sát nhau ⇒ hàng chờ cụt ⇒ xe kẹt (`K4` after
    P11c: V001 kẹt 978 frame). Rải đều theo x giữ được tính chất "hàng chờ" mà không
    dồn cục bộ. Vẫn tất định: `rng` chỉ dùng để xáo thứ tự giữa các ô **cùng x**.
    """
    candidates = [slot for slot in reachable_slots(lot) if str(slot["id"]) in only_ids]
    if len(candidates) < count:
        raise ValueError(
            f"cần {count} ô đếm được nhưng chỉ có {len(candidates)}"
        )
    ordered = sorted(
        rng.shuffle(list(candidates)),
        key=lambda slot: (round(float(slot["center"][0]), 6), str(slot["id"])),
    )
    if count == 1:
        chosen = [ordered[len(ordered) // 2]]
    else:
        # Lấy chỉ số trải đều trên dãy đã sắp theo x.
        step = (len(ordered) - 1) / (count - 1)
        chosen = [ordered[round(index * step)] for index in range(count)]
    unique = {str(slot["id"]): slot for slot in chosen}
    if len(unique) != count:
        raise ValueError(f"cần {count} ô khác nhau, chỉ chọn được {len(unique)}")
    return sorted(unique.values(), key=lambda slot: str(slot["id"]))


def _selected_slots(
    lot: dict[str, Any],
    rng: Mulberry32,
    count: int,
    only_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Chọn ``count`` ô reachable; nếu có ``only_ids`` thì chỉ chọn trong tập đó."""
    candidates = reachable_slots(lot)
    if only_ids is not None:
        candidates = [slot for slot in candidates if str(slot["id"]) in only_ids]
        if len(candidates) < count:
            raise ValueError(
                f"cần {count} ô đếm được nhưng chỉ có {len(candidates)} "
                f"(data/lot/count_slots.json)"
            )
    if count > len(candidates):
        raise ValueError(
            f"cần {count} ô reachable nhưng lot chỉ có {len(candidates)} — chờ P2b"
        )
    chosen = rng.shuffle(list(candidates))[:count]
    return sorted(chosen, key=lambda slot: str(slot["id"]))


def _model_for_slot(rng: Mulberry32, slot: dict[str, Any]) -> str:
    width = float(slot["width_m"])
    if width < NARROW_SLOT_WIDTH_M:
        return "hatch"
    return rng.choice(list(CAR_MODELS))


def _color(rng: Mulberry32) -> str:
    return rng.choice(list(CAR_COLORS))


def effective_scale(model: str, slot_width: float, chosen: float = CAR_SCALE) -> float:
    """Hệ số thực theo D4 (chỉ để test/tài liệu; file mẫu không ghi ``scale``)."""
    car_width = CAR_DIMENSIONS_M[model][1]
    return max(0.5, min(chosen, (slot_width - SLOT_EDGE_MARGIN_M) / car_width))


def _placement(slot: dict[str, Any], car_id: str, model: str, color: str) -> dict[str, Any]:
    return {
        "slot": slot["id"],
        "car_id": car_id,
        "model": model,
        "color": color,
    }


def _add_car(
    frame: int,
    slot: dict[str, Any],
    model: str,
    color: str,
    *,
    park_s: float | None = None,
    speed_kmh: int = DEFAULT_SPEED_KMH,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "slot": slot["id"],
        "speed_kmh": speed_kmh,
        "model": model,
        "color": color,
    }
    if park_s is not None:
        params["park_s"] = park_s
    # Mọi trường đã chỉ định nên không cần `resolved` (không bốc RNG khi chạy).
    return {"frame": frame, "type": "add_car", "params": params}


def _leave(frame: int, car_id: str) -> dict[str, Any]:
    return {"frame": frame, "type": "leave", "params": {"car_id": car_id}}


# --------------------------------------------------------------------------------------
# Môi trường + nhiễu
# --------------------------------------------------------------------------------------
def _noise(seed: int) -> dict[str, Any]:
    config: dict[str, Any] = {
        kind: {"on": False, "level": 0.5} for kind in NOISE_KINDS
    }
    config["seed"] = seed
    return config


def _env_e1() -> dict[str, Any]:
    return {
        "preset": "E1",
        "keyframes": [{"t_s": 0, "hour": 12, "weather": "sun", "intensity": 0.8}],
    }


def _env_e3() -> dict[str, Any]:
    return {
        "preset": "E3",
        "keyframes": [{"t_s": 0, "hour": 14, "weather": "cloud", "intensity": 0.6}],
    }


def _env_e2(duration_frames: int) -> dict[str, Any]:
    return {
        "preset": "E2",
        "keyframes": [
            {"t_s": 0, "hour": 6, "weather": "sun", "intensity": 0.3},
            {
                "t_s": duration_frames // FPS,
                "hour": 18,
                "weather": "sun",
                "intensity": 0.5,
            },
        ],
    }


def _env_e8(duration_frames: int) -> dict[str, Any]:
    return {
        "preset": "E8",
        "keyframes": [
            {
                "t_s": 0,
                "hour": 20,
                "weather": "rain",
                "intensity": 0.8,
                "wet": 0.9,
                "fog": 0.2,
            },
            {
                "t_s": duration_frames // FPS,
                "hour": 23,
                "weather": "rain",
                "intensity": 0.7,
                "wet": 0.8,
                "fog": 0.3,
            },
        ],
    }


def _scenario(
    template_id: str,
    *,
    duration_frames: int,
    env: dict[str, Any],
    placement: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    name, description = TEMPLATE_INFO[template_id]
    seed = TEMPLATE_SEED[template_id]
    return {
        "schema": SCHEMA,
        "name": name,
        "description": description,
        "lot": LOT_NAME,
        "seed": seed,
        "car_scale": CAR_SCALE,
        "default_speed_kmh": DEFAULT_SPEED_KMH,
        "camera_mode": "2cam",
        "initial": {"n_parked": len(placement), "placement": placement},
        "env": env,
        "noise": _noise(seed),
        "events": events,
        "duration_frames": duration_frames,
    }


# --------------------------------------------------------------------------------------
# Từng kịch bản
# --------------------------------------------------------------------------------------
def build_k1(lot: dict[str, Any]) -> dict[str, Any]:
    rng = Mulberry32(TEMPLATE_SEED["K1"])
    slot = _selected_slots(lot, rng, 1)[0]
    model = _model_for_slot(rng, slot)
    color = _color(rng)
    return _scenario(
        "K1",
        duration_frames=3000,
        env=_env_e1(),
        placement=[],
        events=[_add_car(0, slot, model, color, park_s=15)],
    )


def build_k2(lot: dict[str, Any]) -> dict[str, Any]:
    """3 xe vào cách đúng 2 s (50 frame), hai xe cùng màu.

    P11c/ANS_17: chỉ dùng **ô đếm được cổng** (lo trình vào/ra cắt vạch đúng 1 lần).
    """
    rng = Mulberry32(TEMPLATE_SEED["K2"])
    slots = _spread_slots(lot, rng, 3, countable_slot_ids())
    pair_color = _color(rng)
    other_color = rng.choice([color for color in CAR_COLORS if color != pair_color])
    colors = [pair_color, pair_color, other_color]
    events = [
        _add_car(index * 2 * FPS, slot, _model_for_slot(rng, slot), colors[index], park_s=15)
        for index, slot in enumerate(slots)
    ]
    return _scenario(
        "K2", duration_frames=3600, env=_env_e3(), placement=[], events=events
    )


def build_k3(lot: dict[str, Any]) -> dict[str, Any]:
    """Xe đỗ sẵn rời lúc xe mới đã vào lối (2 s sau khi qua cổng)."""
    rng = Mulberry32(TEMPLATE_SEED["K3"])
    slots = _selected_slots(lot, rng, 2)
    parked_slot, new_slot = slots[0], slots[1]
    model = _model_for_slot(rng, parked_slot)
    color = _color(rng)
    events = [
        _add_car(0, new_slot, _model_for_slot(rng, new_slot), _color(rng)),
        _leave(2 * FPS, "V001"),
    ]
    return _scenario(
        "K3",
        duration_frames=3000,
        env=_env_e1(),
        placement=[_placement(parked_slot, "V001", model, color)],
        events=events,
    )


def build_k4(lot: dict[str, Any]) -> dict[str, Any]:
    """6 xe cùng frame 0 để dồn hàng chờ ngoài cổng."""
    rng = Mulberry32(TEMPLATE_SEED["K4"])
    slots = _spread_slots(lot, rng, 6, countable_slot_ids())
    events = [
        _add_car(0, slot, _model_for_slot(rng, slot), _color(rng), park_s=10)
        for slot in slots
    ]
    return _scenario(
        "K4", duration_frames=4000, env=_env_e1(), placement=[], events=events
    )

def build_k5(lot: dict[str, Any]) -> dict[str, Any]:
    """20 chu trình rải đều 6 s (150 frame), E2 cả ngày."""
    duration = 6000
    rng = Mulberry32(TEMPLATE_SEED["K5"])
    slots = _selected_slots(lot, rng, 20)
    step = 150
    events = [
        _add_car(index * step, slot, _model_for_slot(rng, slot), _color(rng), park_s=10)
        for index, slot in enumerate(slots)
    ]
    return _scenario(
        "K5",
        duration_frames=duration,
        env=_env_e2(duration),
        placement=[],
        events=events,
    )


def build_k6(lot: dict[str, Any]) -> dict[str, Any]:
    """8 chu trình rải đều 12 s (300 frame), E8 đêm mưa."""
    duration = 4200
    rng = Mulberry32(TEMPLATE_SEED["K6"])
    slots = _spread_slots(lot, rng, 8, countable_slot_ids())
    step = 300
    events = [
        _add_car(index * step, slot, _model_for_slot(rng, slot), _color(rng), park_s=10)
        for index, slot in enumerate(slots)
    ]
    return _scenario(
        "K6",
        duration_frames=duration,
        env=_env_e8(duration),
        placement=[],
        events=events,
    )


def build_k7(lot: dict[str, Any]) -> dict[str, Any]:
    """90 xe đỗ sẵn + 5 cặp ra/vào (V001–V005 rời, 5 xe mới vào ô trống)."""
    rng = Mulberry32(TEMPLATE_SEED["K7"])
    slots = _selected_slots(lot, rng, 95)
    parked_slots = slots[:90]
    new_slots = slots[90:]
    placement = [
        _placement(
            slot,
            f"V{index + 1:03d}",
            _model_for_slot(rng, slot),
            _color(rng),
        )
        for index, slot in enumerate(parked_slots)
    ]
    events: list[dict[str, Any]] = []
    for index, slot in enumerate(new_slots):
        frame = index * 400
        events.append(_leave(frame, f"V{index + 1:03d}"))
        events.append(
            _add_car(frame, slot, _model_for_slot(rng, slot), _color(rng))
        )
    return _scenario(
        "K7", duration_frames=3000, env=_env_e1(), placement=placement, events=events
    )


def build_k8(lot: dict[str, Any]) -> dict[str, Any]:
    """Tĩnh kiểm thu: 30 xe đỗ sẵn, không sự kiện, đúng 20 s (500 frame)."""
    rng = Mulberry32(TEMPLATE_SEED["K8"])
    slots = _selected_slots(lot, rng, 30)
    placement = [
        _placement(
            slot,
            f"V{index + 1:03d}",
            _model_for_slot(rng, slot),
            _color(rng),
        )
        for index, slot in enumerate(slots)
    ]
    return _scenario(
        "K8",
        duration_frames=20 * FPS,
        env=_env_e1(),
        placement=placement,
        events=[],
    )


BUILDERS = {
    "K1": build_k1,
    "K2": build_k2,
    "K3": build_k3,
    "K4": build_k4,
    "K5": build_k5,
    "K6": build_k6,
    "K7": build_k7,
    "K8": build_k8,
}


def build_all_templates(lot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Sinh cả 8 kịch bản trong bộ nhớ, theo thứ tự K1…K8."""
    return {template_id: builder(lot) for template_id, builder in sorted(BUILDERS.items())}


def serialize(template: dict[str, Any]) -> str:
    """Chuỗi JSON cố định: UTF-8, 2 dấu cách, LF, có newline cuối."""
    return json.dumps(template, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def write_templates(
    templates: dict[str, dict[str, Any]], directory: Path = TEMPLATES_DIR
) -> list[Path]:
    """Ghi ``<id>.sim3d.json``, LF cố định; trả danh sách đường dẫn đã ghi."""
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for template_id, template in sorted(templates.items()):
        path = directory / f"{template_id}.sim3d.json"
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(serialize(template))
        written.append(path)
    return written


def template_path(template_id: str, directory: Path = TEMPLATES_DIR) -> Path:
    return directory / f"{template_id}.sim3d.json"


def main() -> int:
    lot = load_lot()
    templates = build_all_templates(lot)
    written = write_templates(templates)
    for path in written:
        template_id = path.name.removesuffix(".sim3d.json")
        template = templates[template_id]
        initial = template["initial"]
        assert isinstance(initial, dict)
        print(
            f"wrote {path.relative_to(SIM3D_ROOT).as_posix()}: "
            f"{initial['n_parked']} parked, {len(template['events'])} events, "
            f"{template['duration_frames']} frames"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

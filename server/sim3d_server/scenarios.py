"""Kịch bản: kiểm ``schema == 1``, đọc/ghi/xoá (BE §3, §6.2; contract C-B §5–§6).

Bản kiểm này soi gương ``web/src/contracts/scenario.ts`` — FE kiểm trước, BE kiểm lại
để không ai ghi được dữ liệu rác xuống đĩa (R2).
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from sim3d_server import config
from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError, Request, Response
from sim3d_server.util import iso_utc

SCHEMA = 1
CAMERA_MODES = ("1cam", "2cam")
CAR_MODELS = ("sedan", "suv", "hatch")
CAR_COLORS = ("white", "black", "silver", "gray", "red", "blue", "green", "sand")
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
MAX_SEED = 0xFFFFFFFF
MAX_DURATION_FRAMES = 2_000_000


class ScenarioValidationError(Exception):
    """Lỗi dữ liệu kịch bản; ``path`` chỉ đúng trường sai (contract C-B §6.2)."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def _fail(path: str, message: str) -> None:
    raise ScenarioValidationError(path, message)


def _record(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        _fail(path, "phải là object")
    return value


def _array(value: object, path: str) -> list[object]:
    if not isinstance(value, list):
        _fail(path, "phải là mảng")
    return value


def _integer(value: object, path: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        _fail(path, f"phải là số nguyên trong [{low}, {high}]")
    return value


def _number(value: object, path: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, f"phải là số trong [{low}, {high}]")
    cast = float(value)
    if not low <= cast <= high:
        _fail(path, f"phải là số trong [{low}, {high}]")
    return cast


def _string(value: object, path: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(path, "phải là chuỗi không rỗng")
    return value


def _boolean(value: object, path: str) -> bool:
    if not isinstance(value, bool):
        _fail(path, "phải là boolean")
    return value


def _enum(value: object, path: str, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        _fail(path, f"phải là một trong: {', '.join(allowed)}")
    return value


def validate_scenario(raw: object) -> None:
    """Ném ``ScenarioValidationError`` nếu ``raw`` không phải ``Scenario`` schema 1."""
    root = _record(raw, "$")
    if isinstance(root.get("schema"), bool) or root.get("schema") != SCHEMA:
        _fail("schema", f"phải bằng {SCHEMA}")
    _string(root.get("lot"), "lot")
    _integer(root.get("seed"), "seed", 0, MAX_SEED)
    _number(root.get("car_scale"), "car_scale", 1.0, 1.3)
    _number(root.get("default_speed_kmh"), "default_speed_kmh", 5, 20)
    _enum(root.get("camera_mode"), "camera_mode", CAMERA_MODES)
    duration_frames = _integer(
        root.get("duration_frames"), "duration_frames", 0, MAX_DURATION_FRAMES
    )

    initial = _record(root.get("initial"), "initial")
    n_parked = _integer(initial.get("n_parked"), "initial.n_parked", 0, 100)
    placement_raw = _array(initial.get("placement"), "initial.placement")
    if len(placement_raw) != n_parked:
        _fail(
            "initial.placement",
            f"có {len(placement_raw)} phần tử nhưng n_parked = {n_parked}",
        )
    seen_slots: set[str] = set()
    seen_cars: set[str] = set()
    for index, item in enumerate(placement_raw):
        at = f"initial.placement[{index}]"
        entry = _record(item, at)
        slot = _string(entry.get("slot"), f"{at}.slot")
        if slot not in config.SLOT_ID_SET:
            _fail(f"{at}.slot", f'ô "{slot}" ngoài S001–S100')
        car_id = _string(entry.get("car_id"), f"{at}.car_id")
        _enum(entry.get("model"), f"{at}.model", CAR_MODELS)
        _enum(entry.get("color"), f"{at}.color", CAR_COLORS)
        if slot in seen_slots:
            _fail(f"{at}.slot", f'ô "{slot}" bị xếp hai xe')
        seen_slots.add(slot)
        if car_id in seen_cars:
            _fail(f"{at}.car_id", f'mã xe "{car_id}" bị trùng')
        seen_cars.add(car_id)
        if "scale" in entry:
            _number(entry["scale"], f"{at}.scale", 1.0, 1.3)

    env = _record(root.get("env"), "env")
    preset = env.get("preset")
    if preset is not None:
        _string(preset, "env.preset")
    keyframes_raw = _array(env.get("keyframes"), "env.keyframes")
    if not keyframes_raw:
        _fail("env.keyframes", "phải có ít nhất một mốc")
    for index, item in enumerate(keyframes_raw):
        at = f"env.keyframes[{index}]"
        keyframe = _record(item, at)
        _number(keyframe.get("t_s"), f"{at}.t_s", 0, 1e6)
        _number(keyframe.get("hour"), f"{at}.hour", 0, 24)
        _enum(keyframe.get("weather"), f"{at}.weather", WEATHERS)
        _number(keyframe.get("intensity"), f"{at}.intensity", 0, 1)
        if "wet" in keyframe:
            _number(keyframe["wet"], f"{at}.wet", 0, 1)
        if "fog" in keyframe:
            _number(keyframe["fog"], f"{at}.fog", 0, 1)

    noise = _record(root.get("noise"), "noise")
    _integer(noise.get("seed"), "noise.seed", 0, MAX_SEED)
    for kind in NOISE_KINDS:
        toggle = _record(noise.get(kind), f"noise.{kind}")
        _boolean(toggle.get("on"), f"noise.{kind}.on")
        _number(toggle.get("level"), f"noise.{kind}.level", 0, 1)

    events_raw = _array(root.get("events"), "events")
    last_frame = -1
    for index, item in enumerate(events_raw):
        at = f"events[{index}]"
        event = _record(item, at)
        frame = _integer(event.get("frame"), f"{at}.frame", 0, duration_frames)
        if frame < last_frame:
            _fail(f"{at}.frame", f"phải tăng dần (D9 cấm tua lùi), gặp {frame} sau {last_frame}")
        last_frame = frame
        _enum(event.get("type"), f"{at}.type", EVENT_TYPES)
        _record(event.get("params"), f"{at}.params")


def scenario_path(paths: DataPaths, name: str) -> Path:
    """Đường dẫn file kịch bản; tên sai là 400 (contract C-B §6.1)."""
    if not config.NAME_RE.fullmatch(name):
        raise HttpError(
            400,
            ERROR_NAMES[400],
            f'tên kịch bản không hợp lệ: "{name}" (chỉ A-Z a-z 0-9 _ -)',
        )
    return paths.scenarios_dir / f"{name}{config.SCENARIO_SUFFIX}"


def _read_json_file(path: Path, not_found_detail: str) -> object:
    if not path.is_file():
        raise HttpError(404, ERROR_NAMES[404], not_found_detail)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"{path.name}: {type(error).__name__}: {error}",
        ) from error


def list_scenarios(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/scenarios`` — mới sửa trước (contract C-B §5)."""
    del request, params
    directory = paths.scenarios_dir
    if not directory.is_dir():
        return Response.json(200, [])
    entries = [
        {
            "name": path.name[: -len(config.SCENARIO_SUFFIX)],
            "modified_at": iso_utc(
                datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
            ),
        }
        for path in directory.glob(f"*{config.SCENARIO_SUFFIX}")
        if path.is_file()
    ]
    entries.sort(key=lambda entry: entry["modified_at"], reverse=True)
    return Response.json(200, entries)


def get_scenario(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/scenarios/<name>``."""
    del request
    name = params["name"]
    path = scenario_path(paths, name)
    body = _read_json_file(path, f'không có kịch bản "{name}"')
    return Response.json(200, body)


def save_scenario(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``PUT /api/scenarios/<name>`` — kiểm rồi ghi, sai trả 400 kèm đường dẫn trường."""
    name = params["name"]
    path = scenario_path(paths, name)
    raw = request.read_json(config.MAX_JSON_BYTES)
    try:
        validate_scenario(raw)
    except ScenarioValidationError as error:
        raise HttpError(
            400,
            ERROR_NAMES[400],
            f"{config.SCENARIOS_DIRNAME}/{path.name}: {error}",
        ) from error
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return Response.no_content()


def delete_scenario(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``DELETE /api/scenarios/<name>`` — 404 nếu không có."""
    del request
    name = params["name"]
    path = scenario_path(paths, name)
    if not path.is_file():
        raise HttpError(404, ERROR_NAMES[404], f'không có kịch bản "{name}"')
    path.unlink()
    return Response.no_content()

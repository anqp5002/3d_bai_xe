"""Test 8 kịch bản mẫu K1–K8 (P9a, FE §5 dòng 88).

Chạy::

    python sim3d/tools/gen_templates.py
    python -m pytest sim3d/tools -q

Test đọc lot đã có (`data/lot/lot_pucpr.json`) để kiểm ô `reachable`, và so từng file
trên đĩa với kết quả generator (bắt quên chạy lại sau P2b).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

import gen_templates as gt
import pytest

TEMPLATE_IDS = tuple(f"K{index}" for index in range(1, 9))
WEB_ROOT = gt.SIM3D_ROOT / "web"


# --------------------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def lot() -> dict[str, Any]:
    return gt.load_lot()


@pytest.fixture(scope="module")
def templates(lot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return gt.build_all_templates(lot)


@pytest.fixture(scope="module")
def slots_by_id(lot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(slot["id"]): slot for slot in lot["slots"]}


@pytest.fixture(scope="module")
def reachable_ids(lot: dict[str, Any]) -> set[str]:
    return {str(slot["id"]) for slot in gt.reachable_slots(lot)}


# --------------------------------------------------------------------------------------
# File trên đĩa khớp generator (tất định, đã chạy lại sau khi sửa lot)
# --------------------------------------------------------------------------------------
def test_files_exist_and_match_generator(
    templates: dict[str, dict[str, Any]],
) -> None:
    for template_id in TEMPLATE_IDS:
        path = gt.template_path(template_id)
        assert path.is_file(), f"thiếu {path}"
        assert path.read_text(encoding="utf-8") == gt.serialize(templates[template_id]), (
            f"{path.name} lệch generator — chạy lại gen_templates.py"
        )


def test_no_extra_template_files() -> None:
    on_disk = {path.name for path in gt.TEMPLATES_DIR.glob("*.sim3d.json")}
    expected = {f"{template_id}.sim3d.json" for template_id in TEMPLATE_IDS}
    assert on_disk == expected


def test_files_are_utf8_lf_with_trailing_newline() -> None:
    for template_id in TEMPLATE_IDS:
        path = gt.template_path(template_id)
        raw = path.read_bytes()
        assert b"\r\n" not in raw, f"{path.name} phải dùng LF"
        assert raw.endswith(b"\n")
        raw.decode("utf-8")  # không ném = UTF-8 hợp lệ


def test_generator_is_deterministic(lot: dict[str, Any]) -> None:
    first = {key: gt.serialize(value) for key, value in gt.build_all_templates(lot).items()}
    second = {key: gt.serialize(value) for key, value in gt.build_all_templates(lot).items()}
    assert first == second


# --------------------------------------------------------------------------------------
# Hợp schema (cùng luật với contracts/scenario.ts:validateScenario)
# --------------------------------------------------------------------------------------
def test_schema_required_fields(templates: dict[str, dict[str, Any]]) -> None:
    for template_id, scenario in templates.items():
        assert scenario["schema"] == 1, template_id
        assert scenario["lot"] == "pucpr", template_id
        assert isinstance(scenario["name"], str) and scenario["name"], template_id
        assert isinstance(scenario["description"], str) and scenario["description"], template_id

        seed = scenario["seed"]
        assert isinstance(seed, int) and 0 <= seed <= 0xFFFFFFFF, template_id
        assert isinstance(scenario["car_scale"], (int, float))
        assert gt.CAR_SCALE_MIN <= scenario["car_scale"] <= gt.CAR_SCALE_MAX, template_id
        assert gt.SPEED_MIN_KMH <= scenario["default_speed_kmh"] <= gt.SPEED_MAX_KMH
        assert scenario["camera_mode"] in gt.CAMERA_MODES
        assert isinstance(scenario["duration_frames"], int)
        assert 0 < scenario["duration_frames"] <= 2_000_000

        initial = scenario["initial"]
        assert isinstance(initial, dict)
        placement = initial["placement"]
        assert isinstance(placement, list)
        assert initial["n_parked"] == len(placement)
        assert 0 <= initial["n_parked"] <= 100
        car_ids: set[str] = set()
        slot_ids: set[str] = set()
        for entry in placement:
            assert _is_slot_id(entry["slot"]), entry
            assert entry["slot"] not in slot_ids, f"{template_id}: trùng ô {entry['slot']}"
            slot_ids.add(entry["slot"])
            assert entry["car_id"] not in car_ids
            car_ids.add(entry["car_id"])
            assert entry["model"] in gt.CAR_MODELS
            assert entry["color"] in gt.CAR_COLORS
            assert "scale" not in entry, (
                "không ghi scale trong placement: validator chỉ nhận 1,00–1,30, "
                "còn D4 có thể cho < 1,0"
            )

        env = scenario["env"]
        assert env["preset"] in ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8")
        keyframes = env["keyframes"]
        assert isinstance(keyframes, list) and keyframes
        for keyframe in keyframes:
            assert 0 <= keyframe["t_s"] <= 1_000_000
            assert 0 <= keyframe["hour"] <= 24
            assert keyframe["weather"] in gt.WEATHERS
            assert 0 <= keyframe["intensity"] <= 1
            for optional in ("wet", "fog"):
                if optional in keyframe:
                    assert 0 <= keyframe[optional] <= 1

        noise = scenario["noise"]
        for kind in gt.NOISE_KINDS:
            toggle = noise[kind]
            assert isinstance(toggle["on"], bool)
            assert 0 <= toggle["level"] <= 1
        assert isinstance(noise["seed"], int)
        assert 0 <= noise["seed"] <= 0xFFFFFFFF

        events = scenario["events"]
        assert isinstance(events, list)
        last_frame = -1
        for event in events:
            assert event["type"] in gt.EVENT_TYPES
            frame = event["frame"]
            assert isinstance(frame, int)
            assert last_frame <= frame <= scenario["duration_frames"]
            last_frame = frame
            assert isinstance(event["params"], dict)
            _assert_event_params(template_id, event, car_ids)


def _assert_event_params(
    template_id: str,
    event: dict[str, Any],
    initial_car_ids: set[str],
) -> None:
    params = event["params"]
    if event["type"] == "add_car":
        assert _is_slot_id(params["slot"]), (template_id, params)
        assert gt.SPEED_MIN_KMH <= params["speed_kmh"] <= gt.SPEED_MAX_KMH
        assert params["model"] in gt.CAR_MODELS
        assert params["color"] in gt.CAR_COLORS
        if "park_s" in params:
            assert params["park_s"] >= 0
    elif event["type"] == "leave":
        assert params["car_id"] in initial_car_ids, (template_id, params)
    elif event["type"] == "set_speed":
        assert params["car_id"] in initial_car_ids
        assert gt.SPEED_MIN_KMH <= params["speed_kmh"] <= gt.SPEED_MAX_KMH
    else:
        pytest.fail(f"{template_id}: test chưa phủ loại sự kiện {event['type']}")


def _is_slot_id(value: str) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 4
        and value[0] == "S"
        and value[1:].isdigit()
        and 1 <= int(value[1:]) <= 100
    )


# --------------------------------------------------------------------------------------
# Ô dùng đúng: chỉ S001–S100, thuộc reachable, không trùng
# --------------------------------------------------------------------------------------
def test_all_slots_are_reachable_and_not_duplicated(
    templates: dict[str, dict[str, Any]], reachable_ids: set[str]
) -> None:
    for template_id, scenario in templates.items():
        initial_slots = [entry["slot"] for entry in scenario["initial"]["placement"]]
        assert len(initial_slots) == len(set(initial_slots)), template_id
        assert set(initial_slots) <= reachable_ids, (
            f"{template_id}: có ô đỗ sẵn không reachable: "
            f"{sorted(set(initial_slots) - reachable_ids)}"
        )

        event_slots: list[str] = [
            event["params"]["slot"]
            for event in scenario["events"]
            if event["type"] == "add_car"
        ]
        assert len(event_slots) == len(set(event_slots)), f"{template_id}: trùng ô sự kiện"
        assert set(event_slots) <= reachable_ids, (
            f"{template_id}: có ô sự kiện không reachable: "
            f"{sorted(set(event_slots) - reachable_ids)}"
        )
        assert not (set(event_slots) & set(initial_slots)), (
            f"{template_id}: sự kiện nhắm ô đã có xe đỗ sẵn"
        )


# --------------------------------------------------------------------------------------
# D4: tỉ lệ xe + ô hẹp chỉ hatchback
# --------------------------------------------------------------------------------------
def test_d4_scale_and_narrow_slots(
    templates: dict[str, dict[str, Any]], slots_by_id: dict[str, dict[str, Any]]
) -> None:
    for template_id, scenario in templates.items():
        for entry in scenario["initial"]["placement"]:
            slot = slots_by_id[entry["slot"]]
            width = float(slot["width_m"])
            model = entry["model"]
            if width < gt.NARROW_SLOT_WIDTH_M:
                assert model == "hatch", (
                    f"{template_id}/{entry['slot']}: ô hẹp {width:.2f} m chỉ nhận hatch"
                )
            scale = gt.effective_scale(model, width)
            assert 0.5 <= scale <= gt.CAR_SCALE_MAX
            car_width = gt.CAR_DIMENSIONS_M[model][1]
            assert car_width * scale <= width - gt.SLOT_EDGE_MARGIN_M + 1e-9


# --------------------------------------------------------------------------------------
# Nội dung từng kịch bản (FE §5 dòng 88)
# --------------------------------------------------------------------------------------
def _add_events(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    return [event for event in scenario["events"] if event["type"] == "add_car"]


def test_k1_single_car(templates: dict[str, dict[str, Any]]) -> None:
    scenario = templates["K1"]
    assert scenario["initial"]["n_parked"] == 0
    assert scenario["env"]["preset"] == "E1"
    add_events = _add_events(scenario)
    assert len(add_events) == 1
    assert add_events[0]["params"]["park_s"] == 15


def test_k2_three_cars_two_seconds_and_same_color(
    templates: dict[str, dict[str, Any]],
) -> None:
    scenario = templates["K2"]
    assert scenario["env"]["preset"] == "E3"
    add_events = _add_events(scenario)
    assert len(add_events) == 3
    assert [event["frame"] for event in add_events] == [0, 50, 100]
    colors = [event["params"]["color"] for event in add_events]
    counts = {color: colors.count(color) for color in set(colors)}
    assert max(counts.values()) >= 2, f"K2 phải có cặp cùng màu: {colors}"


def test_k3_exit_entry_crossing(templates: dict[str, dict[str, Any]]) -> None:
    scenario = templates["K3"]
    assert scenario["initial"]["n_parked"] >= 1
    assert scenario["env"]["preset"] == "E1"
    add_events = _add_events(scenario)
    leave_events = [event for event in scenario["events"] if event["type"] == "leave"]
    assert len(add_events) == 1
    assert len(leave_events) == 1
    assert abs(leave_events[0]["frame"] - add_events[0]["frame"]) <= 100


def test_k4_six_cars_queue_at_gate(templates: dict[str, dict[str, Any]]) -> None:
    scenario = templates["K4"]
    add_events = _add_events(scenario)
    assert len(add_events) == 6
    assert all(event["frame"] == 0 for event in add_events)
    assert scenario["env"]["preset"] == "E1"


def test_k5_day_twenty_cycles_evenly_spread(
    templates: dict[str, dict[str, Any]],
) -> None:
    scenario = templates["K5"]
    assert scenario["env"]["preset"] == "E2"
    add_events = _add_events(scenario)
    assert len(add_events) == 20
    frames = [event["frame"] for event in add_events]
    gaps = {frames[index + 1] - frames[index] for index in range(len(frames) - 1)}
    assert len(gaps) == 1, f"K5 phải rải đều, gaps={sorted(gaps)}"
    assert frames[-1] < scenario["duration_frames"]


def test_k6_night_rain_eight_cycles(templates: dict[str, dict[str, Any]]) -> None:
    scenario = templates["K6"]
    assert scenario["env"]["preset"] == "E8"
    add_events = _add_events(scenario)
    assert len(add_events) == 8
    keyframes = scenario["env"]["keyframes"]
    assert any(keyframe["weather"] == "rain" for keyframe in keyframes)
    assert max(keyframe["hour"] for keyframe in keyframes) >= 18


def test_k7_full_lot_ninety_parked_five_in_out(
    templates: dict[str, dict[str, Any]],
) -> None:
    scenario = templates["K7"]
    assert scenario["initial"]["n_parked"] == 90
    assert len(scenario["initial"]["placement"]) == 90
    add_events = _add_events(scenario)
    leave_events = [event for event in scenario["events"] if event["type"] == "leave"]
    assert len(add_events) == 5
    assert len(leave_events) == 5
    parked_ids = {entry["car_id"] for entry in scenario["initial"]["placement"]}
    assert {event["params"]["car_id"] for event in leave_events} <= parked_ids


def test_k8_static_audit_exact(templates: dict[str, dict[str, Any]]) -> None:
    scenario = templates["K8"]
    assert scenario["initial"]["n_parked"] == 30
    assert len(scenario["initial"]["placement"]) == 30
    assert scenario["events"] == []
    assert scenario["duration_frames"] == 20 * gt.FPS == 500
    assert scenario["env"]["preset"] == "E1"
    assert scenario["camera_mode"] == "2cam"


def test_names_and_descriptions_match_defaults(
    templates: dict[str, dict[str, Any]],
) -> None:
    for template_id, scenario in templates.items():
        name, description = gt.TEMPLATE_INFO[template_id]
        assert scenario["name"] == name
        assert scenario["description"] == description


# --------------------------------------------------------------------------------------
# JSON roundtrip
# --------------------------------------------------------------------------------------
def test_json_roundtrip_keeps_content() -> None:
    for template_id in TEMPLATE_IDS:
        path = gt.template_path(template_id)
        reloaded = json.loads(path.read_text(encoding="utf-8"))
        assert reloaded["schema"] == 1
        assert reloaded["initial"]["n_parked"] == len(reloaded["initial"]["placement"])


# --------------------------------------------------------------------------------------
# Nạp từng file qua validator thật của contracts/scenario.ts (FE/BE dùng chung)
# --------------------------------------------------------------------------------------
def test_templates_pass_ts_validator() -> None:
    """Gọi `validateScenario` thật bằng Vite SSR; thiếu Node/vite thì skip rõ lý do.

    TASK chỉ cho sửa file Python + JSON mẫu, nên test TS nằm trong pytest này thay vì
    thêm một file `src/**/*.test.ts` (xem REPORT_P9a mục "Chưa chắc").
    """
    node = shutil.which("node")
    if node is None or not (WEB_ROOT / "node_modules" / "vite").is_dir():
        pytest.skip("không có node hoặc sim3d/web/node_modules/vite — bỏ validator TS")

    templates_dir = json.dumps(gt.TEMPLATES_DIR.as_posix())
    ids = json.dumps(list(TEMPLATE_IDS))
    script = f"""
import {{ readFileSync }} from 'node:fs';
import {{ join }} from 'node:path';
import {{ createServer }} from 'vite';

const server = await createServer({{
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  server: {{ middlewareMode: true }},
  appType: 'custom',
}});
try {{
  const {{ validateScenario }} = await server.ssrLoadModule('/src/contracts/scenario.ts');
  for (const id of {ids}) {{
    const raw = JSON.parse(readFileSync(join({templates_dir}, `${{id}}.sim3d.json`), 'utf8'));
    validateScenario(raw);
    console.log(`${{id}}:OK`);
  }}
}} finally {{
  await server.close();
}}
"""
    completed = subprocess.run(
        [node, "--input-type=module"],
        input=script,
        text=True,
        capture_output=True,
        cwd=str(WEB_ROOT),
        timeout=180,
        check=False,
    )
    assert completed.returncode == 0, (
        "validator TS báo lỗi:\n"
        f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
    )
    for template_id in TEMPLATE_IDS:
        assert f"{template_id}:OK" in completed.stdout

"""Lưu/đọc/xoá kịch bản + kiểm schema (BE §7, contract C-B §5–§6)."""

from __future__ import annotations

import json

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.http import HttpError
from sim3d_server.server import App
from tests.helpers import dispatch, dispatch_json, make_scenario


def test_save_read_list_delete(app: App, data_root: DataPaths) -> None:
    scenario = make_scenario()
    assert dispatch_json(app, "PUT", "/api/scenarios/thu-nghiem-1", scenario).status == 204
    path = data_root.scenarios_dir / "thu-nghiem-1.sim3d.json"
    assert path.is_file()

    response = dispatch(app, "GET", "/api/scenarios/thu-nghiem-1")
    assert response.status == 200
    assert response.body == scenario

    listing = dispatch(app, "GET", "/api/scenarios")
    assert listing.status == 200
    assert [entry["name"] for entry in listing.body] == ["thu-nghiem-1"]
    assert listing.body[0]["modified_at"].endswith("Z")

    assert dispatch(app, "DELETE", "/api/scenarios/thu-nghiem-1").status == 204
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/scenarios/thu-nghiem-1")
    assert excinfo.value.status == 404


def test_delete_missing_scenario_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "DELETE", "/api/scenarios/khong-co")
    assert excinfo.value.status == 404


def test_schema_wrong_is_400(app: App, data_root: DataPaths) -> None:
    scenario = make_scenario()
    scenario["schema"] = 2
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "PUT", "/api/scenarios/sai-schema", scenario)
    assert excinfo.value.status == 400
    assert "schema" in excinfo.value.detail
    assert not (data_root.scenarios_dir / "sai-schema.sim3d.json").exists()


def test_missing_required_field_is_400(app: App) -> None:
    scenario = make_scenario()
    del scenario["lot"]
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "PUT", "/api/scenarios/thieu-truong", scenario)
    assert excinfo.value.status == 400
    assert "lot" in excinfo.value.detail


def test_placement_count_mismatch_is_400(app: App) -> None:
    scenario = make_scenario()
    scenario["initial"] = {
        "n_parked": 2,
        "placement": [
            {"slot": "S004", "car_id": "V001", "model": "sedan", "color": "white"}
        ],
    }
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "PUT", "/api/scenarios/lech-so-xe", scenario)
    assert excinfo.value.status == 400
    assert "initial.placement" in excinfo.value.detail


def test_events_must_be_non_decreasing(app: App) -> None:
    scenario = make_scenario(duration_frames=100)
    scenario["events"] = [
        {"frame": 10, "type": "add_car", "params": {}},
        {"frame": 5, "type": "add_car", "params": {}},
    ]
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "PUT", "/api/scenarios/tua-lui", scenario)
    assert excinfo.value.status == 400
    assert "events[1].frame" in excinfo.value.detail


def test_invalid_scenario_name_is_400(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch_json(app, "PUT", "/api/scenarios/ten co dau cach", make_scenario())
    assert excinfo.value.status == 400
    assert "tên kịch bản" in excinfo.value.detail


def test_scenario_name_traversal_is_400(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/scenarios/..%2F..%2Fetc")
    assert excinfo.value.status == 400


def test_put_invalid_json_is_400(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "PUT", "/api/scenarios/hong-json", b"{ khong phai json", "application/json")
    assert excinfo.value.status == 400
    assert "JSON" in excinfo.value.detail


def test_saved_file_is_valid_utf8_json(app: App, data_root: DataPaths) -> None:
    scenario = make_scenario()
    dispatch_json(app, "PUT", "/api/scenarios/kiem-tra", scenario)
    raw = (data_root.scenarios_dir / "kiem-tra.sim3d.json").read_text(encoding="utf-8")
    assert json.loads(raw)["schema"] == 1

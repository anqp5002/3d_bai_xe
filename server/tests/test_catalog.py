"""Bãi + thư viện kịch bản mẫu (contract C-B §2–§4)."""

from __future__ import annotations

import json

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.http import HttpError
from sim3d_server.server import App
from tests.helpers import dispatch, make_scenario, write_lot


def test_lot_missing_is_404(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/lot/pucpr")
    assert excinfo.value.status == 404
    assert "lot_pucpr.json" in excinfo.value.detail


def test_lot_returns_file(app: App, data_root: DataPaths) -> None:
    write_lot(data_root)
    response = dispatch(app, "GET", "/api/lot/pucpr")
    assert response.status == 200
    assert response.body["name"] == "pucpr"
    assert len(response.body["slots"]) == 100


def test_templates_list_uses_default_name(app: App, data_root: DataPaths) -> None:
    (data_root.templates_dir / "K1.sim3d.json").write_text(
        json.dumps(make_scenario()), encoding="utf-8"
    )
    (data_root.templates_dir / "K8.sim3d.json").write_text(
        json.dumps({**make_scenario(), "name": "Tĩnh", "description": "mô tả riêng"}),
        encoding="utf-8",
    )
    response = dispatch(app, "GET", "/api/templates")
    assert response.status == 200
    assert [entry["id"] for entry in response.body] == ["K1", "K8"]
    assert response.body[0]["name"] == "Xe đơn"
    assert response.body[1] == {"id": "K8", "name": "Tĩnh", "description": "mô tả riêng"}


def test_template_content_and_missing(app: App, data_root: DataPaths) -> None:
    scenario = make_scenario()
    (data_root.templates_dir / "K2.sim3d.json").write_text(
        json.dumps(scenario), encoding="utf-8"
    )
    response = dispatch(app, "GET", "/api/templates/K2")
    assert response.status == 200
    assert response.body == scenario

    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/templates/K9")
    assert excinfo.value.status == 404
    assert 'không có template "K9"' in excinfo.value.detail


def test_template_id_traversal_is_403(app: App) -> None:
    with pytest.raises(HttpError) as excinfo:
        dispatch(app, "GET", "/api/templates/..%2Fsecret")
    assert excinfo.value.status == 403

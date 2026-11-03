"""Bãi + thư viện kịch bản mẫu (BE §3, contract C-B §2–§4)."""

from __future__ import annotations

import json
from pathlib import Path

from sim3d_server import config
from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError, Request, Response


def _load_json(path: Path, detail: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HttpError(500, ERROR_NAMES[500], f"{detail}: {type(error).__name__}: {error}") from error


def get_lot(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/lot/pucpr`` — trả nguyên ``data/lot/lot_pucpr.json``."""
    del request, params
    path = paths.lot_file
    if not path.is_file():
        raise HttpError(
            404,
            ERROR_NAMES[404],
            f"chưa có {config.LOT_DIRNAME}/{config.LOT_PUCPR_FILENAME}",
        )
    return Response.json(200, _load_json(path, path.name))


def list_templates(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/templates`` — id, tên, mô tả của K1–K8 (contract C-B §3)."""
    del request, params
    directory = paths.templates_dir
    entries: list[dict[str, str]] = []
    if directory.is_dir():
        for path in sorted(directory.glob(f"*{config.SCENARIO_SUFFIX}")):
            if not path.is_file():
                continue
            template_id = path.name[: -len(config.SCENARIO_SUFFIX)]
            name, description = config.TEMPLATE_DEFAULTS.get(template_id, (template_id, ""))
            content = _load_json(path, path.name)
            if isinstance(content, dict):
                if isinstance(content.get("name"), str) and content["name"]:
                    name = content["name"]
                if isinstance(content.get("description"), str) and content["description"]:
                    description = content["description"]
            entries.append({"id": template_id, "name": name, "description": description})
    entries.sort(key=lambda entry: entry["id"])
    return Response.json(200, entries)


def get_template(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/templates/<id>`` — 403 khi id có ký tự lạ (contract C-B §4)."""
    del request
    template_id = params["template_id"]
    if not config.NAME_RE.fullmatch(template_id):
        raise HttpError(
            403,
            ERROR_NAMES[403],
            f'id template không hợp lệ: "{template_id}"',
        )
    path = paths.templates_dir / f"{template_id}{config.SCENARIO_SUFFIX}"
    if not path.is_file():
        raise HttpError(404, ERROR_NAMES[404], f'không có template "{template_id}"')
    return Response.json(200, _load_json(path, path.name))

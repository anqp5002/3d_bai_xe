"""Bảng tuyến API đã chốt (contract C-B §1–§13)."""

from __future__ import annotations

from http import HTTPStatus

from sim3d_server import catalog, runs, scenarios
from sim3d_server.config import DataPaths
from sim3d_server.http import Request, Response, Route
from sim3d_server.media import ffmpeg_path
from sim3d_server.version import VERSION


def health_handler(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/health`` → ``{ok, version, ffmpeg}`` (BE §3)."""
    del request, paths, params
    return Response.json(
        HTTPStatus.OK,
        {"ok": True, "version": VERSION, "ffmpeg": ffmpeg_path() is not None},
    )


ROUTES = (
    Route("GET", "/api/health", health_handler),
    Route("GET", "/api/lot/pucpr", catalog.get_lot),
    Route("GET", "/api/templates", catalog.list_templates),
    Route("GET", "/api/templates/{template_id}", catalog.get_template),
    Route("GET", "/api/scenarios", scenarios.list_scenarios),
    Route("GET", "/api/scenarios/{name}", scenarios.get_scenario),
    Route("PUT", "/api/scenarios/{name}", scenarios.save_scenario),
    Route("DELETE", "/api/scenarios/{name}", scenarios.delete_scenario),
    Route("POST", "/api/runs", runs.create_run),
    Route("GET", "/api/runs", runs.list_runs),
    Route("GET", "/api/runs/{run_id}", runs.get_run),
    Route("PUT", "/api/runs/{run_id}/files/{path...}", runs.put_file),
    Route("POST", "/api/runs/{run_id}/frames", runs.post_frame),
    Route("POST", "/api/runs/{run_id}/finalize", runs.finalize),
    Route("POST", "/api/runs/{run_id}/open-folder", runs.open_folder),
)

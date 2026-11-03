"""Phục vụ tĩnh ``sim3d/web/dist`` (BE §1, contract C-B §13).

``/api/*`` luôn được xử lý trước; mọi path không có phần mở rộng rơi về ``index.html`` (SPA).
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote

from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError, Response

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


def _file_response(path: Path) -> Response:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"{path.name}: {type(error).__name__}: {error}",
        ) from error
    content_type = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return Response(status=200, payload=payload, content_type=content_type)


def serve_static(paths: DataPaths, request_path: str) -> Response:
    """Trả file trong ``web/dist``; chưa build thì 404 kèm hướng dẫn."""
    dist = paths.web_dist_dir
    if not dist.is_dir():
        raise HttpError(404, ERROR_NAMES[404], "chưa build web/dist (npm run build)")
    root = dist.resolve()
    relative = unquote(request_path).lstrip("/")
    if relative in ("", "."):
        candidate = root / "index.html"
    else:
        candidate = (root / relative).resolve()
        if candidate != root and root not in candidate.parents:
            raise HttpError(404, ERROR_NAMES[404], f"không có file {relative}")
    if candidate.is_file():
        return _file_response(candidate)
    if not Path(relative).suffix:
        index = root / "index.html"
        if index.is_file():
            return _file_response(index)
    raise HttpError(404, ERROR_NAMES[404], f"không có file {relative}")

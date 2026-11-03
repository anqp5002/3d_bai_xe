"""Lần xuất: tạo, nhận file theo luồng, PNG dự phòng, finalize (BE §2–§4).

Mọi lỗi đường dẫn trả 403 ``forbidden_path``; body ghi theo luồng, không đọc cả file vào RAM
(trừ một frame PNG của đường dự phòng).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from sim3d_server import config, media, verify
from sim3d_server.config import DataPaths
from sim3d_server.http import (
    ERROR_NAMES,
    HttpError,
    Request,
    Response,
    parse_multipart,
)
from sim3d_server.util import iso_utc

#: Content-Type đúng theo đuôi file (contract C-B §8).
CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
}

#: Giới hạn body theo đuôi file (contract C-B §0.2).
BODY_LIMITS = {
    ".mp4": config.MAX_VIDEO_BYTES,
    ".json": config.MAX_JSON_BYTES,
    ".csv": config.MAX_CSV_BYTES,
    ".txt": config.MAX_JSON_BYTES,
}

#: Chữ ký PNG, kiểm trước khi ghi frame (contract C-B §9).
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _require_run(paths: DataPaths, run_id: str) -> Path:
    """Thư mục lần xuất đã tồn tại; sai/không có đều 404 (contract C-B §8, §11)."""
    if not config.NAME_RE.fullmatch(run_id):
        raise HttpError(404, ERROR_NAMES[404], f'không có lần xuất "{run_id}"')
    run_dir = paths.runs_dir / run_id
    if not run_dir.is_dir():
        raise HttpError(404, ERROR_NAMES[404], f'không có lần xuất "{run_id}"')
    return run_dir


def _check_relative(raw_path: str) -> str:
    """Chỉ nhận path tuyệt đối-không, không ``..``, nằm trong whitelist (contract C-B §8)."""
    forbidden = (
        ".." in raw_path
        or "\\" in raw_path
        or ":" in raw_path
        or raw_path.startswith("/")
        or any(segment in ("", ".", "..") for segment in raw_path.split("/"))
    )
    if forbidden:
        raise HttpError(403, ERROR_NAMES[403], f"path không được phép: {raw_path}")
    if raw_path not in config.ALLOWED_RUN_FILES:
        raise HttpError(403, ERROR_NAMES[403], f"path không được phép: {raw_path}")
    return raw_path


def _check_content_type(raw_path: str, content_type: str | None) -> None:
    """Content-Type phải khớp đuôi; thiếu header thì suy theo đuôi (BE ghi theo luồng)."""
    if content_type is None or not content_type.strip():
        return
    expected = CONTENT_TYPES[Path(raw_path).suffix]
    actual = content_type.split(";")[0].strip().lower()
    if actual != expected:
        raise HttpError(
            415,
            ERROR_NAMES[415],
            f"{raw_path}: Content-Type phải là {expected}, nhận {actual}",
        )


def create_run(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``POST /api/runs`` — tạo ``runs/<run_id>/``, không ghi đè (BE §2)."""
    del params
    raw = request.read_json(config.MAX_JSON_BYTES)
    if not isinstance(raw, dict):
        raise HttpError(
            400,
            ERROR_NAMES[400],
            "body phải là object {name, outputs, duration_frames, fps}",
        )
    name = raw.get("name")
    if not isinstance(name, str) or not config.RUN_NAME_RE.fullmatch(name):
        raise HttpError(400, ERROR_NAMES[400], "name phải khớp [A-Za-z0-9_-]{1,40}")
    outputs = raw.get("outputs")
    if (
        not isinstance(outputs, list)
        or not outputs
        or any(not isinstance(item, str) or item not in config.OUTPUT_NAMES for item in outputs)
    ):
        raise HttpError(
            400,
            ERROR_NAMES[400],
            'outputs phải là tập con không rỗng của ["full", "cam1", "cam2"]',
        )
    duration_frames = raw.get("duration_frames")
    if (
        isinstance(duration_frames, bool)
        or not isinstance(duration_frames, int)
        or not 0 <= duration_frames <= 2_000_000
    ):
        raise HttpError(
            400,
            ERROR_NAMES[400],
            "duration_frames phải là số nguyên trong [0, 2000000]",
        )
    fps = raw.get("fps")
    if isinstance(fps, bool) or fps != config.FPS:
        raise HttpError(400, ERROR_NAMES[400], f"fps phải bằng {config.FPS}")

    paths.runs_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"{stamp}_{name}"
    for suffix in range(1, 100):
        run_id = base if suffix == 1 else f"{base}-{suffix}"
        try:
            (paths.runs_dir / run_id).mkdir()
        except FileExistsError:
            continue
        return Response.json(200, {"run_id": run_id})
    raise HttpError(
        409,
        ERROR_NAMES[409],
        f"vượt 99 lần trùng tên trong một giây: {base}",
    )


def put_file(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``PUT /api/runs/<run_id>/files/<path>`` — ghi nguyên file theo luồng."""
    run_dir = _require_run(paths, params["run_id"])
    relative = _check_relative(params["path"])
    _check_content_type(relative, request.header("Content-Type"))
    if request.header("Content-Length") is None:
        raise HttpError(
            400,
            ERROR_NAMES[400],
            "thiếu Content-Length; BE ghi file theo luồng (BE §3)",
        )
    limit = BODY_LIMITS[Path(relative).suffix]
    target = run_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    try:
        with temporary.open("wb") as handle:
            for chunk in request.iter_body(limit):
                handle.write(chunk)
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return Response.no_content()


def post_frame(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``POST /api/runs/<run_id>/frames`` — nhận một PNG, ghi ``frames_tmp/%06d.png``."""
    run_dir = _require_run(paths, params["run_id"])
    content_type = request.header("Content-Type") or ""
    if not content_type.lower().startswith("multipart/form-data"):
        raise HttpError(
            415,
            ERROR_NAMES[415],
            "frames cần multipart/form-data (contract C-B §9)",
        )
    body = request.read_body(config.MAX_FRAMES_BYTES)
    try:
        parts = parse_multipart(body, content_type)
    except ValueError as error:
        raise HttpError(400, ERROR_NAMES[400], f"multipart hỏng: {error}") from error

    index_raw = next((part for part in parts if part.name == "frame_index"), None)
    file_part = next((part for part in parts if part.name == "file"), None)
    if index_raw is None:
        raise HttpError(400, ERROR_NAMES[400], 'thiếu trường "frame_index"')
    if file_part is None:
        raise HttpError(400, ERROR_NAMES[400], 'thiếu trường "file"')
    try:
        index_text = index_raw.data.decode("utf-8").strip()
        frame_index = int(index_text)
    except (UnicodeDecodeError, ValueError) as error:
        raise HttpError(
            400,
            ERROR_NAMES[400],
            f"frame_index phải là số nguyên ≥ 0, nhận {index_raw.data!r}",
        ) from error
    if frame_index < 0:
        raise HttpError(400, ERROR_NAMES[400], f"frame_index phải ≥ 0, nhận {frame_index}")
    if not file_part.data.startswith(PNG_SIGNATURE):
        raise HttpError(400, ERROR_NAMES[400], "file gửi lên không phải PNG")
    decoded = cv2.imdecode(np.frombuffer(file_part.data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise HttpError(400, ERROR_NAMES[400], "PNG không đọc được (cv2.imdecode trả None)")

    frames_dir = run_dir / "frames_tmp"
    frames_dir.mkdir(parents=True, exist_ok=True)
    destination = frames_dir / f"{frame_index:06d}.png"
    temporary = frames_dir / f"{frame_index:06d}.png.part"
    try:
        temporary.write_bytes(file_part.data)
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return Response.no_content()


def finalize(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``POST /api/runs/<run_id>/finalize`` — ghép PNG (nếu có) rồi chạy 6 mục kiểm."""
    del request
    run_id = params["run_id"]
    run_dir = _require_run(paths, run_id)
    started = time.perf_counter()
    frames_dir = run_dir / "frames_tmp"
    if frames_dir.is_dir():
        indices = media.frame_indices(frames_dir)
        if indices:
            missing = media.missing_frames(indices)
            if missing:
                preview = ", ".join(f"{index:06d}" for index in missing[:10])
                more = "" if len(missing) <= 10 else f" (và {len(missing) - 10} frame nữa)"
                raise HttpError(
                    400,
                    ERROR_NAMES[400],
                    f"frames_tmp/: thiếu frame {preview}{more}; không tự lấp (R2)",
                )
            media.merge_frames(frames_dir, run_dir / "raw_full.mp4")
            shutil.rmtree(frames_dir)
    elapsed = time.perf_counter() - started
    report = verify.verify_run(paths, run_id, elapsed)
    return Response.json(200, report)


def _read_verify(run_dir: Path) -> object | None:
    path = run_dir / "verify.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"verify.json của {run_dir.name} hỏng: {type(error).__name__}: {error}",
        ) from error


def _run_entry(run_dir: Path) -> dict[str, object]:
    created = datetime.fromtimestamp(run_dir.stat().st_mtime, tz=UTC)
    files = sorted(
        path.relative_to(run_dir).as_posix()
        for path in run_dir.rglob("*")
        if path.is_file()
    )
    return {
        "run_id": run_dir.name,
        "created_at": iso_utc(created),
        "files": files,
        "verify": _read_verify(run_dir),
    }


def list_runs(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/runs`` — mới nhất trước (contract C-B §11.1)."""
    del request, params
    directory = paths.runs_dir
    if not directory.is_dir():
        return Response.json(200, [])
    run_dirs = sorted(
        (path for path in directory.iterdir() if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return Response.json(200, [_run_entry(run_dir) for run_dir in run_dirs])


def get_run(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``GET /api/runs/<run_id>`` (contract C-B §11.2)."""
    del request
    run_dir = _require_run(paths, params["run_id"])
    return Response.json(200, _run_entry(run_dir))


def open_folder(request: Request, paths: DataPaths, params: dict[str, str]) -> Response:
    """``POST /api/runs/<run_id>/open-folder`` — chỉ Windows (contract C-B §12)."""
    del request
    run_dir = _require_run(paths, params["run_id"])
    if sys.platform != "win32":
        raise HttpError(
            501,
            ERROR_NAMES[501],
            "open-folder chỉ hỗ trợ Windows",
        )
    os.startfile(str(run_dir))
    return Response.json(200, {"ok": True, "path": str(run_dir)})

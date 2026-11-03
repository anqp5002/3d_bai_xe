"""Đường dự phòng PNG → mp4 bằng ffmpeg (BE §4.3, D12).

Không tự lấp frame thiếu (R2). Không có ffmpeg thì báo 503 kèm hướng dẫn cài.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from sim3d_server import config
from sim3d_server.http import ERROR_NAMES, HttpError

#: Lời hướng dẫn khi máy chưa có ffmpeg (contract C-B §10).
FFMPEG_INSTALL_HINT = (
    "Cần ffmpeg để ghép frames_tmp/. Cài: winget install Gyan.FFmpeg, rồi mở lại terminal."
)


def ffmpeg_path() -> str | None:
    """Đường dẫn ``ffmpeg`` trong PATH, ``None`` nếu không có."""
    return shutil.which("ffmpeg")


def frame_indices(frames_dir: Path) -> list[int]:
    """Danh sách chỉ số frame PNG đã nhận (``%06d.png``, bắt đầu 0)."""
    indices: list[int] = []
    for path in frames_dir.glob("*.png"):
        try:
            indices.append(int(path.stem))
        except ValueError as error:
            raise HttpError(
                400,
                ERROR_NAMES[400],
                f"{path.name}: tên frame phải là số (định dạng %06d.png)",
            ) from error
    return sorted(indices)


def missing_frames(indices: list[int]) -> list[int]:
    """Các chỉ số còn thiếu trong dãy ``0..max`` (rỗng nếu liền mạch)."""
    if not indices:
        return []
    present = set(indices)
    return [index for index in range(max(indices) + 1) if index not in present]


def merge_frames(frames_dir: Path, output: Path) -> None:
    """Ghép ``frames_dir/%06d.png`` thành ``output`` đúng 25 fps (BE §4.3)."""
    binary = ffmpeg_path()
    if binary is None:
        raise HttpError(503, ERROR_NAMES[503], FFMPEG_INSTALL_HINT)
    command = [
        binary,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(config.FPS),
        "-start_number",
        "0",
        "-i",
        str(frames_dir / "%06d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(config.FPS),
        str(output),
    ]
    try:
        completed = subprocess.run(
            command, check=False, capture_output=True, text=True, timeout=600
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"ffmpeg không chạy được: {type(error).__name__}: {error}",
        ) from error
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()[-2000:]
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"ffmpeg thoát mã {completed.returncode}: {stderr}",
        )
    if not output.is_file() or output.stat().st_size == 0:
        raise HttpError(
            500,
            ERROR_NAMES[500],
            f"ffmpeg báo xong nhưng {output.name} không có hoặc rỗng",
        )

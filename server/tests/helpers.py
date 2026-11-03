"""Dựng dữ liệu + gọi handler cho test BE (BE §7).

Không phải module test (tên không bắt đầu bằng ``test_``).
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import cv2
import numpy as np

from sim3d_server.config import DataPaths
from sim3d_server.http import Request, Response
from sim3d_server.server import App

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


def dispatch(
    app: App,
    method: str,
    path: str,
    body: bytes = b"",
    content_type: str | None = None,
) -> Response:
    """Gọi thẳng ``App.dispatch`` với body trong bộ nhớ (không cần mở cổng)."""
    headers: dict[str, str] = {"Content-Length": str(len(body))}
    if content_type is not None:
        headers["Content-Type"] = content_type
    request = Request(
        method=method,
        path=path,
        query={},
        headers=headers,
        body_reader=io.BytesIO(body) if body else None,
        content_length=len(body),
    )
    return app.dispatch(request)


def dispatch_json(app: App, method: str, path: str, payload: object) -> Response:
    return dispatch(
        app,
        method,
        path,
        json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        "application/json",
    )


def put_run_file(
    app: App,
    run_id: str,
    relative: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> Response:
    return dispatch(app, "PUT", f"/api/runs/{run_id}/files/{relative}", data, content_type)


def make_scenario(duration_frames: int = 5, **overrides: object) -> dict[str, object]:
    """Kịch bản hợp lệ tối thiểu (đủ trường bắt buộc của contract C-B §6.2)."""
    noise: dict[str, object] = {kind: {"on": False, "level": 0.5} for kind in NOISE_KINDS}
    noise["seed"] = 7
    scenario: dict[str, object] = {
        "schema": 1,
        "lot": "pucpr",
        "seed": 7,
        "car_scale": 1.1,
        "default_speed_kmh": 10,
        "camera_mode": "1cam",
        "initial": {"n_parked": 0, "placement": []},
        "env": {
            "preset": "E1",
            "keyframes": [
                {"t_s": 0, "hour": 12, "weather": "sun", "intensity": 0.8}
            ],
        },
        "noise": noise,
        "events": [],
        "duration_frames": duration_frames,
    }
    scenario.update(overrides)
    return scenario


def write_lot(paths: DataPaths) -> None:
    """Bãi tối thiểu: 100 ô xếp lưới trong khung 640×640 (đủ để vẽ overlay)."""
    slots = []
    for index, slot_id in enumerate(_slot_ids()):
        column = index % 10
        row = index // 10
        left = 20 + column * 60
        top = 20 + row * 60
        slots.append(
            {
                "id": slot_id,
                "row": str(row + 1),
                "center": [left + 20, top + 20],
                "heading": 0,
                "polygon_px": [
                    [left, top],
                    [left + 40, top],
                    [left + 40, top + 40],
                    [left, top + 40],
                ],
                "polygon": [
                    [left / 10, top / 10],
                    [(left + 40) / 10, top / 10],
                    [(left + 40) / 10, (top + 40) / 10],
                    [left / 10, (top + 40) / 10],
                ],
                "width_m": 2.4,
                "reachable": True,
            }
        )
    paths.lot_file.parent.mkdir(parents=True, exist_ok=True)
    paths.lot_file.write_text(
        json.dumps({"name": "pucpr", "slots": slots}, ensure_ascii=False),
        encoding="utf-8",
    )


def _slot_ids() -> list[str]:
    return [f"S{index:03d}" for index in range(1, 101)]


def write_video(path: Path, frames: int, size: tuple[int, int] = (640, 640)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"mp4v"), 25.0, size
    )
    if not writer.isOpened():
        raise RuntimeError("không mở được cv2.VideoWriter (mp4v)")
    try:
        for index in range(frames):
            frame = np.full((size[1], size[0], 3), index * 20 % 255, dtype=np.uint8)
            writer.write(frame)
    finally:
        writer.release()


def build_run(
    paths: DataPaths,
    run_id: str = "20261031-041500_kiem-thu",
    frames: int = 5,
    *,
    camera_mode: str = "1cam",
    skip_video_frames: int | None = None,
    drop_slot_column: str | None = None,
    drop_techgar_file: str | None = None,
    with_lot: bool = True,
    with_video: bool = True,
    with_full_video: bool = True,
    with_techgar: bool = True,
    video_size: tuple[int, int] = (400, 640),
) -> Path:
    """Dựng một ``data/runs/<run_id>/`` đủ file cho ``verify_run``.

    ``camera_mode`` quyết định file video bắt buộc (1cam: full; 2cam: full+cam1+cam2).
    ``skip_video_frames``: ghi video ít hơn GT để thử mục 1 báo sai.
    ``drop_slot_column``: bỏ một cột ô để thử mục 2 báo thiếu.
    ``with_techgar=False``: không tạo ``techgar_config/`` (dùng cho test 1 cam).
    """
    run_dir = paths.runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    if with_lot:
        write_lot(paths)

    (run_dir / "scenario.sim3d.json").write_text(
        json.dumps(make_scenario(frames, camera_mode=camera_mode), ensure_ascii=False),
        encoding="utf-8",
    )

    slot_ids = _slot_ids()
    header = ["frame", *slot_ids, "V001_u", "V001_v", "V001_cams"]
    if drop_slot_column is not None:
        header.remove(drop_slot_column)
    with (run_dir / "gt_frames.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for frame in range(frames):
            row: dict[str, object] = {"frame": frame, "V001_u": 320.0, "V001_v": 320.0}
            row["V001_cams"] = "cam1+cam2"
            for slot_id in slot_ids:
                row[slot_id] = 1 if slot_id == "S001" else 0
            writer.writerow([row[column] for column in header])

    with (run_dir / "gt_events.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "car",
                "slot",
                "gate_in_frame",
                "parked_frame",
                "depart_frame",
                "cam2_to_cam1_overlap_enter",
                "gate_out_frame",
                "arrival_crosses_cameras",
                "initial_parked",
                "model",
                "color",
                "speed_kmh",
            ]
        )
        writer.writerow(["V001", "S001", 1, 2, 3, 3, 4, 0, 0, "sedan", "white", 10])

    with (run_dir / "frame_timestamps.csv").open(
        "w", encoding="utf-8", newline=""
    ) as handle:
        writer = csv.writer(handle)
        writer.writerow(["frame_idx", "cam1_monotonic_ns", "cam2_monotonic_ns"])
        for frame in range(frames):
            ns = 1_000_000_000_000 + frame * 40_000_000
            writer.writerow([frame + 1, ns, ns])

    video_frames = skip_video_frames or frames
    if with_video:
        if with_full_video:
            # `raw_full` luôn 640x640 (xem `_expected_video_sizes`), không theo `video_size`.
            write_video(run_dir / "raw_full.mp4", video_frames, (640, 640))
        if camera_mode == "2cam":
            write_video(run_dir / "raw_cam1.mp4", video_frames, video_size)
            write_video(run_dir / "raw_cam2.mp4", video_frames, video_size)

    if with_techgar:
        config_dir = run_dir / "techgar_config"
        config_dir.mkdir(parents=True, exist_ok=True)
        for name in (
            "calibration.json",
            "gate_zones.json",
            "roi_mask_cam1.json",
            "roi_mask_cam2.json",
            "MANIFEST.json",
        ):
            (config_dir / name).write_text("{}", encoding="utf-8")
        for name in ("parking_slots_cam1.json", "parking_slots_cam2.json"):
            (config_dir / name).write_text(
                json.dumps(
                    {
                        "imageWidth": video_size[0],
                        "imageHeight": video_size[1],
                        "slots": [{"id": "S001"}, {"id": "S002"}],
                    }
                ),
                encoding="utf-8",
            )
        (config_dir / "README.txt").write_text("sim3d\n", encoding="utf-8")
        if drop_techgar_file is not None:
            (config_dir / drop_techgar_file).unlink()
    return run_dir

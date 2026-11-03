"""Đo track M1 (P15b): recall xe-frame đang chạy + đo theo từng xe.

Nguồn gốc: ``.orca/sim3d/recall_probe.py`` (director dùng để đo 24 %/5 % đêm mưa và
29 %/27 % K2). Script này giữ nguyên định nghĩa recall đó, dọn lại để chạy độc lập bằng
venv của ``sim3d``, và thêm phần đo **theo xe**:

- mỗi xe chạy (state ``entering``/``driving``/``exiting`` suy từ ``gt_events.csv``) có được
  cấp ``canonical_gid`` không;
- số lần đứt track (đổi ``local_track_id``/GID, hoặc mất dấu rồi hiện lại) trong một xe;
- GID bị tái sử dụng cho nhiều xe.

Chỉ đoạn tuyến **nằm trong mask** của cam mới được tính cho phần theo xe. Điểm GT
(``_u/_v``) được đưa về đúng không gian ảnh của run bằng ``image_size``/``s`` trong
``techgar_config/MANIFEST.json`` (không hard-code 400×640).

Chạy::

    python sim3d/tools/m1_track_eval.py <RUN> [--predictions <predictions.jsonl>]

Mặc định đọc ``<RUN>/m1/session/predictions.jsonl``. Ghi JSON nếu truyền ``--json``.

Định nghĩa recall (giữ đúng ``recall_probe.py``)
------------------------------------------------
Xe-frame đang chạy = frame mà xe có mặt trong ``gt_frames.csv`` và tâm xe dịch chuyển
> 0,3 px so với frame trước đó (đơn vị pixel gốc 400×640, nhân theo ``s`` khi run xuất lớn).
Observation "đang chuyển động" = ``observation_kind == "detection"`` và
``|vx| + |vy| > 0,2``. Tỉ lệ = tổng min(số observation, số xe GT) / tổng xe GT, mỗi cam.

Đo theo xe
----------
- Đoạn chạy của xe lấy từ ``gt_events.csv``: từ ``gate_in_frame`` (hoặc frame đầu tiên xe
  thực sự nhích nếu thiếu mốc) tới hết run, trừ khoảng đỗ
  ``[parked_frame, depart_frame)``. Xe đỗ sẵn chỉ tính từ ``depart_frame``.
- Một điểm GT thuộc cam nếu ``_cams`` chứa cam đó **và** điểm nằm trong polygon
  ``roi_mask_cam*.json``.
- Ghép GT ↔ observation theo ``anchor_pixel`` gần nhất trong bán kính ``--match-radius``
  (mặc định 30 px gốc), mỗi observation chỉ ghép một xe.
- Đứt track: đổi ``(camera, local_track_id)`` hoặc đổi ``canonical_gid``; hoặc có frame
  đủ điều kiện nằm giữa hai lần khớp mà xe không được ghép.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

#: Kích thước gốc của sim (rộng × cao). ``MANIFEST.image_size`` ghi theo thứ tự
#: ``[width, height]`` — xem ``TECHGAR_IMAGE`` trong ``sim3d/web/src/export/techgarConfig.ts``.
BASE_WIDTH: Final = 400
BASE_HEIGHT: Final = 640

#: Ngưỡng dịch chuyển tâm xe để coi là "đang chạy", pixel gốc 400×640.
DEFAULT_MOVE_PX: Final = 0.3
#: Ngưỡng tốc độ observation để coi là "đang chuyển động", pixel/frame gốc.
DEFAULT_OBS_MIN_VELOCITY: Final = 0.2
#: Bán kính ghép GT ↔ observation, pixel gốc.
DEFAULT_MATCH_RADIUS_PX: Final = 30.0

#: Mất dấu >= ngần này frame GT-đang-chạy-trong-mask (1 s) mới tính là đứt thật; ngắn hơn là
#: nhấp nháy phát hiện, và xe đỗ không có frame 'đang chạy' nên không bị tính (P16).
HARD_GAP_FRAMES: Final = 25

CAMERAS: Final = ("cam1", "cam2")


# ---------------------------------------------------------------------------------------
# Đọc dữ liệu run
# ---------------------------------------------------------------------------------------
@dataclass(frozen=True)
class ImageSpace:
    """Không gian pixel của run + hệ số so với khung gốc 400×640."""

    width: int
    height: int
    #: Hệ số ``s`` của run (1 = 400×640).
    scale: float
    #: Nội dung ``MANIFEST.json`` (rỗng nếu run cũ không có).
    manifest: dict[str, object] = field(default_factory=dict)

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height


def read_manifest(run_dir: Path) -> dict[str, object]:
    path = run_dir / "techgar_config" / "MANIFEST.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def image_space(run_dir: Path, manifest: dict[str, object] | None = None) -> ImageSpace:
    """Đọc ``image_size`` và ``s`` từ MANIFEST; thiếu thì mặc định 400×640, s = 1."""
    data = read_manifest(run_dir) if manifest is None else manifest
    raw = data.get("image_size")
    width, height = BASE_WIDTH, BASE_HEIGHT
    if isinstance(raw, (list, tuple)) and len(raw) == 2:
        width, height = int(raw[0]), int(raw[1])
    scale_raw = data.get("s")
    if isinstance(scale_raw, (int, float)) and float(scale_raw) > 0:
        scale = float(scale_raw)
    else:
        scale = width / BASE_WIDTH if BASE_WIDTH else 1.0
    return ImageSpace(width=width, height=height, scale=scale, manifest=data)


@dataclass(frozen=True)
class GtPoint:
    frame: int
    u: float
    v: float
    cams: str


def read_gt_cars(path: Path) -> dict[str, list[GtPoint]]:
    """``gt_frames.csv`` → ``{car: [(frame, u, v, cams)]}`` (bỏ frame không có toạ độ)."""
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            return {}
        index = {name: position for position, name in enumerate(header)}
        cars = [name[:-2] for name in header if name.endswith("_u")]
        out: dict[str, list[GtPoint]] = {car: [] for car in cars}
        for row in reader:
            if not row:
                continue
            try:
                frame = int(row[index["frame"]])
            except (KeyError, ValueError):
                continue
            for car in cars:
                iu = index.get(f"{car}_u")
                iv = index.get(f"{car}_v")
                ic = index.get(f"{car}_cams")
                if iu is None or iv is None or iu >= len(row) or iv >= len(row):
                    continue
                if row[iu].strip() == "" or row[iv].strip() == "":
                    continue
                try:
                    u = float(row[iu])
                    v = float(row[iv])
                except ValueError:
                    continue
                cams = row[ic] if ic is not None and ic < len(row) else ""
                out[car].append(GtPoint(frame=frame, u=u, v=v, cams=cams))
    for points in out.values():
        points.sort(key=lambda point: point.frame)
    return out


@dataclass(frozen=True)
class GtEvent:
    car: str
    slot: str | None
    gate_in_frame: int | None
    parked_frame: int | None
    depart_frame: int | None
    gate_out_frame: int | None
    initial_parked: bool


def _maybe_int(value: str | None) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    return int(float(value))


def read_gt_events(path: Path) -> dict[str, GtEvent]:
    if not path.exists():
        return {}
    out: dict[str, GtEvent] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            car = (row.get("car") or "").strip()
            if not car:
                continue
            out[car] = GtEvent(
                car=car,
                slot=(row.get("slot") or "").strip() or None,
                gate_in_frame=_maybe_int(row.get("gate_in_frame")),
                parked_frame=_maybe_int(row.get("parked_frame")),
                depart_frame=_maybe_int(row.get("depart_frame")),
                gate_out_frame=_maybe_int(row.get("gate_out_frame")),
                initial_parked=_maybe_int(row.get("initial_parked")) == 1,
            )
    return out


def read_mask(path: Path, target: ImageSpace) -> list[tuple[float, float]] | None:
    """Đọc polygon mask; co theo ``image_size`` của MANIFEST nếu file còn ở cỡ gốc."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    polygon = data.get("polygon") if isinstance(data, dict) else None
    if not isinstance(polygon, list) or len(polygon) < 3:
        return None
    points: list[tuple[float, float]] = []
    for item in polygon:
        if not isinstance(item, dict):
            continue
        try:
            points.append((float(item["x"]), float(item["y"])))
        except (KeyError, TypeError, ValueError):
            return None
    if len(points) < 3:
        return None
    mask_size = data.get("image_size") if isinstance(data, dict) else None
    mask_width = None
    if isinstance(mask_size, (list, tuple)) and len(mask_size) == 2:
        # ``image_size`` cũng theo thứ tự [width, height].
        mask_width = float(mask_size[0])
    if mask_width and mask_width > 0 and abs(mask_width - target.width) > 0.5:
        factor = target.width / mask_width
        points = [(x * factor, y * factor) for x, y in points]
    return points


def point_in_polygon(x: float, y: float, polygon: Sequence[tuple[float, float]]) -> bool:
    """Ray casting; biên tính là trong (đủ cho mask chữ nhật)."""
    inside = False
    count = len(polygon)
    for index in range(count):
        x1, y1 = polygon[index]
        x2, y2 = polygon[(index + 1) % count]
        if (y1 > y) != (y2 > y):
            cross = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < cross:
                inside = not inside
    return inside


# ---------------------------------------------------------------------------------------
# Đọc predictions
# ---------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Observation:
    cam: str
    x: float
    y: float
    gid: str | None
    local_track_id: int | None
    moving: bool


@dataclass
class FrameData:
    #: Số observation "đang chuyển động" mỗi cam (dùng cho recall xe-frame).
    moving_counts: dict[str, int] = field(default_factory=lambda: {cam: 0 for cam in CAMERAS})
    #: Số observation đang chuyển động **có** canonical_gid mỗi cam.
    gid_counts: dict[str, int] = field(default_factory=lambda: {cam: 0 for cam in CAMERAS})
    #: Mọi observation detection mỗi cam (dùng để ghép theo xe).
    observations: dict[str, list[Observation]] = field(
        default_factory=lambda: {cam: [] for cam in CAMERAS}
    )


def _anchor(obs: dict[str, object]) -> tuple[float, float] | None:
    anchor = obs.get("anchor_pixel")
    if isinstance(anchor, dict):
        try:
            return float(anchor["x"]), float(anchor["y"])
        except (KeyError, TypeError, ValueError):
            pass
    bbox = obs.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
        try:
            x, y, w, h = (float(value) for value in bbox[:4])
            return x + w / 2.0, y + h
        except (TypeError, ValueError):
            return None
    return None


def read_predictions(
    path: Path,
    *,
    obs_min_velocity: float = DEFAULT_OBS_MIN_VELOCITY,
) -> dict[int, FrameData]:
    """``predictions.jsonl`` → ``{frame (0-based): FrameData}``.

    Giữ đúng quy ước ``recall_probe.py``: ``frame = frame_idx - 1``.
    """
    out: dict[int, FrameData] = {}
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            frame = int(record["frame_idx"]) - 1
            data = FrameData()
            for obs in record.get("observations") or []:
                if not isinstance(obs, dict):
                    continue
                cam = str(obs.get("camera_id"))
                if cam not in CAMERAS:
                    continue
                if obs.get("observation_kind") != "detection":
                    continue
                anchor = _anchor(obs)
                if anchor is None:
                    continue
                velocity = obs.get("velocity_px_per_frame") or (0.0, 0.0)
                try:
                    vx, vy = float(velocity[0]), float(velocity[1])
                except (TypeError, ValueError, IndexError):
                    vx = vy = 0.0
                moving = abs(vx) + abs(vy) > obs_min_velocity
                gid = obs.get("canonical_gid")
                gid_value = str(gid) if gid not in (None, "") else None
                local_raw = obs.get("local_track_id")
                try:
                    local = int(local_raw) if local_raw is not None else None
                except (TypeError, ValueError):
                    local = None
                data.observations[cam].append(
                    Observation(
                        cam=cam,
                        x=anchor[0],
                        y=anchor[1],
                        gid=gid_value,
                        local_track_id=local,
                        moving=moving,
                    )
                )
                if moving:
                    data.moving_counts[cam] += 1
                    if gid_value is not None:
                        data.gid_counts[cam] += 1
            out[frame] = data
    return out


# ---------------------------------------------------------------------------------------
# Hệ số pixel GT
# ---------------------------------------------------------------------------------------
def gt_pixel_scale(
    cars: dict[str, list[GtPoint]],
    space: ImageSpace,
    *,
    override: float | None = None,
) -> float:
    """Hệ số nhân toạ độ ``_u/_v`` của GT để về không gian ảnh của run.

    - ``override`` (``--gt-scale``) thắng mọi suy đoán.
    - MANIFEST có ``gt_pixel_scale`` thì dùng luôn.
    - Còn lại: nếu run xuất lớn hơn khung gốc (``s > 1``) nhưng mọi ``u ≤ 400`` và
      ``v ≤ 640`` thì GT vẫn ở cỡ gốc ⇒ nhân ``s``. Ngược lại GT đã ở cỡ ảnh ⇒ nhân 1.

    Đây là chỗ dễ sai nhất khi coders-1 đổi export sang ``s = 2``: export phải nhân cả cột
    ``_u/_v``; export P15a khai báo ``gt_pixel_scale`` trong MANIFEST (GT giữ cỡ 640); phép dò này chỉ cho run cũ (và ``--gt-scale`` để ép).
    """
    if override is not None:
        return float(override)
    declared = space.manifest.get("gt_pixel_scale")
    if isinstance(declared, (int, float)) and float(declared) > 0:
        return float(declared)
    max_u = max((point.u for points in cars.values() for point in points), default=0.0)
    max_v = max((point.v for points in cars.values() for point in points), default=0.0)
    if space.scale > 1 and max_u <= BASE_WIDTH + 0.5 and max_v <= BASE_HEIGHT + 0.5:
        return space.scale
    return 1.0


# ---------------------------------------------------------------------------------------
# Đoạn chạy của từng xe
# ---------------------------------------------------------------------------------------
def _first_moving_frame(points: Sequence[GtPoint], move_px: float) -> int | None:
    previous: GtPoint | None = None
    for point in points:
        if previous is not None and abs(point.u - previous.u) + abs(point.v - previous.v) > move_px:
            return point.frame
        previous = point
    return None


def moving_frames(
    points: Sequence[GtPoint],
    event: GtEvent | None,
    *,
    move_px: float,
) -> list[GtPoint]:
    """Các frame xe đang chạy theo GT (đã trừ khoảng đỗ)."""
    if not points:
        return []
    first = points[0].frame
    last = points[-1].frame
    if event is None:
        start = _first_moving_frame(points, move_px)
        start = first if start is None else start
        return [point for point in points if point.frame >= start]

    if event.initial_parked:
        start = event.depart_frame if event.depart_frame is not None else last + 1
    elif event.gate_in_frame is not None:
        start = event.gate_in_frame
    else:
        start = _first_moving_frame(points, move_px)
        start = first if start is None else start

    parked_from = event.parked_frame
    parked_to = event.depart_frame
    out: list[GtPoint] = []
    for point in points:
        if point.frame < start:
            continue
        if parked_from is not None:
            if parked_to is None:
                if point.frame >= parked_from:
                    continue
            elif parked_from <= point.frame < parked_to:
                continue
        out.append(point)
    return out


# ---------------------------------------------------------------------------------------
# Ghép GT ↔ observation
# ---------------------------------------------------------------------------------------
def associate(
    points: Sequence[tuple[str, float, float, str]],
    observations: dict[str, list[Observation]],
    *,
    radius: float,
) -> dict[str, Observation]:
    """Ghép mỗi xe với observation gần nhất (một-một) trong bán kính ``radius``."""
    candidates: list[tuple[float, str, str, int]] = []
    for car, u, v, cam in points:
        for index, obs in enumerate(observations.get(cam, ())):
            distance = math.hypot(obs.x - u, obs.y - v)
            if distance <= radius:
                candidates.append((distance, car, cam, index))
    candidates.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
    assigned: dict[str, Observation] = {}
    used: set[tuple[str, int]] = set()
    for _, car, cam, index in candidates:
        if car in assigned or (cam, index) in used:
            continue
        assigned[car] = observations[cam][index]
        used.add((cam, index))
    return assigned


# ---------------------------------------------------------------------------------------
# Đo
# ---------------------------------------------------------------------------------------
def measure_frame_recall(
    cars: dict[str, list[GtPoint]],
    predictions: dict[int, FrameData],
    *,
    move_px: float,
) -> dict[str, dict[str, float | int]]:
    """Tỉ lệ xe-frame đang chạy (GT) có observation đang chuyển động, mỗi cam."""
    gt: dict[int, dict[str, int]] = {}
    previous: dict[str, GtPoint] = {}
    for car, points in cars.items():
        for point in points:
            previous_point = previous.get(car)
            previous[car] = point
            if previous_point is None:
                continue
            # Xe vắng mặt rồi hiện lại không tính là chuyển động (giống recall_probe:
            # khi ô toạ độ trống thì ``prev`` bị xoá).
            if point.frame - previous_point.frame > 1:
                continue
            if abs(point.u - previous_point.u) + abs(point.v - previous_point.v) <= move_px:
                continue
            counts = gt.setdefault(point.frame, {cam: 0 for cam in CAMERAS})
            for cam in point.cams.split("+"):
                if cam in counts:
                    counts[cam] += 1

    out: dict[str, dict[str, float | int]] = {}
    for cam in CAMERAS:
        gt_total = sum(counts[cam] for counts in gt.values())
        detected = sum(
            min(predictions.get(frame, FrameData()).moving_counts[cam], counts[cam])
            for frame, counts in gt.items()
        )
        with_gid = sum(
            min(predictions.get(frame, FrameData()).gid_counts[cam], counts[cam])
            for frame, counts in gt.items()
        )
        out[cam] = {
            "gt_moving_frames": gt_total,
            "detected_moving_frames": detected,
            "detected_ratio": detected / gt_total if gt_total else 0.0,
            "gid_frames": with_gid,
            "gid_ratio": with_gid / gt_total if gt_total else 0.0,
        }
    return out


@dataclass
class CarTrack:
    car: str
    slot: str | None
    eligible_frames: int = 0
    matched_frames: int = 0
    gid_frames: int = 0
    gids: set[str] = field(default_factory=set)
    local_tracks: set[str] = field(default_factory=set)
    breaks: int = 0
    hard_breaks: int = 0  # đổi local/GID + mất >= HARD_GAP_FRAMES frame chạy liên tiếp (P16)
    break_reasons: list[str] = field(default_factory=list)

    @property
    def has_gid(self) -> bool:
        return bool(self.gids)

    @property
    def coverage(self) -> float:
        return self.matched_frames / self.eligible_frames if self.eligible_frames else 0.0


def measure_per_car(
    cars: dict[str, list[GtPoint]],
    events: dict[str, GtEvent],
    predictions: dict[int, FrameData],
    masks: dict[str, list[tuple[float, float]] | None],
    *,
    move_px: float,
    radius: float,
) -> dict[str, object]:
    """Đo theo xe: GID, đứt track, GID tái sử dụng — chỉ đoạn tuyến trong mask cam."""
    tracks: dict[str, CarTrack] = {}
    moving: dict[str, set[int]] = {}
    for car, points in cars.items():
        event = events.get(car)
        selected = moving_frames(points, event, move_px=move_px)
        moving[car] = {point.frame for point in selected}
        tracks[car] = CarTrack(car=car, slot=event.slot if event else None)

    # Điểm GT đủ điều kiện: đang chạy, cam thấy, và nằm trong mask cam.
    eligible_by_frame: dict[int, list[tuple[str, float, float, str]]] = defaultdict(list)
    eligible_count: dict[str, int] = defaultdict(int)
    eligible_frames: dict[tuple[str, str], set[int]] = defaultdict(set)
    for car, points in cars.items():
        for point in points:
            if point.frame not in moving[car]:
                continue
            for cam in point.cams.split("+"):
                if cam not in CAMERAS:
                    continue
                mask = masks.get(cam)
                if mask is None or not point_in_polygon(point.u, point.v, mask):
                    continue
                eligible_by_frame[point.frame].append((car, point.u, point.v, cam))
                eligible_count[car] += 1
                eligible_frames[(car, cam)].add(point.frame)
    for car, track in tracks.items():
        track.eligible_frames = eligible_count.get(car, 0)

    # Ghép theo từng frame rồi dựng chuỗi track của mỗi xe/cam.
    sequences: dict[tuple[str, str], list[tuple[int, Observation]]] = defaultdict(list)
    for frame in sorted(eligible_by_frame):
        data = predictions.get(frame)
        if data is None:
            continue
        assigned = associate(eligible_by_frame[frame], data.observations, radius=radius)
        for car, obs in assigned.items():
            track = tracks[car]
            track.matched_frames += 1
            if obs.gid is not None:
                track.gid_frames += 1
                track.gids.add(obs.gid)
            if obs.local_track_id is not None:
                track.local_tracks.add(f"{obs.cam}:{obs.local_track_id}")
            sequences[(car, obs.cam)].append((frame, obs))

    # Đứt track: đổi local track/GID, hoặc mất dấu trong khi GT vẫn đủ điều kiện.
    for (car, cam), sequence in sequences.items():
        track = tracks[car]
        sequence.sort(key=lambda item: item[0])
        for index in range(1, len(sequence)):
            previous_frame, previous_obs = sequence[index - 1]
            frame, obs = sequence[index]
            if frame - previous_frame > 1 and any(
                previous_frame < candidate < frame for candidate in eligible_frames[(car, cam)]
            ):
                track.breaks += 1
                track.break_reasons.append(f"{cam}:gap@{previous_frame}->{frame}")
                missed = sum(
                    1 for candidate in eligible_frames[(car, cam)]
                    if previous_frame < candidate < frame
                )
                if missed >= HARD_GAP_FRAMES:
                    track.hard_breaks += 1
                continue
            if obs.local_track_id != previous_obs.local_track_id:
                track.breaks += 1
                track.hard_breaks += 1
                track.break_reasons.append(
                    f"{cam}:local@{frame}:{previous_obs.local_track_id}->{obs.local_track_id}"
                )
                continue
            if obs.gid != previous_obs.gid and obs.gid is not None and previous_obs.gid is not None:
                track.breaks += 1
                track.hard_breaks += 1
                track.break_reasons.append(
                    f"{cam}:gid@{frame}:{previous_obs.gid}->{obs.gid}"
                )

    # GID dùng cho nhiều xe (chỉ tính observation đã ghép trong đoạn hợp lệ).
    gid_cars: dict[str, set[str]] = defaultdict(set)
    for car, track in tracks.items():
        for gid in track.gids:
            gid_cars[gid].add(car)
    reused = {gid: sorted(members) for gid, members in gid_cars.items() if len(members) > 1}

    measured = [track for track in tracks.values() if track.eligible_frames > 0]
    with_gid = [track for track in measured if track.has_gid]
    with_breaks = [track for track in measured if track.breaks > 0]

    per_car = [
        {
            "car": track.car,
            "slot": track.slot,
            "eligible_frames": track.eligible_frames,
            "matched_frames": track.matched_frames,
            "coverage": round(track.coverage, 4),
            "gid_frames": track.gid_frames,
            "has_gid": track.has_gid,
            "gids": sorted(track.gids),
            "local_tracks": sorted(track.local_tracks),
            "breaks": track.breaks,
            "hard_breaks": track.hard_breaks,
            "break_reasons": track.break_reasons,
        }
        for track in sorted(tracks.values(), key=lambda item: item.car)
    ]

    return {
        "cars_total": len(tracks),
        "cars_measured": len(measured),
        "cars_with_gid": len(with_gid),
        "cars_with_gid_ratio": len(with_gid) / len(measured) if measured else 0.0,
        "cars_with_breaks": len(with_breaks),
        "breaks_total": sum(track.breaks for track in measured),
        "breaks_median": _median([track.breaks for track in measured]),
        "hard_breaks_total": sum(track.hard_breaks for track in measured),
        "hard_breaks_max": max((track.hard_breaks for track in measured), default=0),
        "breaks_max": max((track.breaks for track in measured), default=0),
        "gid_reuse_count": len(reused),
        "gid_reuse": [
            {"gid": gid, "cars": members} for gid, members in sorted(reused.items())
        ],
        "cars": per_car,
    }


def _median(values: Sequence[int]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


# ---------------------------------------------------------------------------------------
# Tổng hợp
# ---------------------------------------------------------------------------------------
def evaluate_run(
    run_dir: Path,
    predictions_path: Path | None = None,
    *,
    move_px: float = DEFAULT_MOVE_PX,
    match_radius_px: float = DEFAULT_MATCH_RADIUS_PX,
    obs_min_velocity: float = DEFAULT_OBS_MIN_VELOCITY,
    gt_scale: float | None = None,
) -> dict[str, object]:
    """Đo toàn bộ mục track của một run và trả dict (dùng được từ ``m1_eval``)."""
    run_dir = run_dir.resolve()
    manifest = read_manifest(run_dir)
    space = image_space(run_dir, manifest)
    cars_raw = read_gt_cars(run_dir / "gt_frames.csv")
    scale = gt_pixel_scale(cars_raw, space, override=gt_scale)

    cars: dict[str, list[GtPoint]] = {}
    for car, points in cars_raw.items():
        cars[car] = [
            GtPoint(frame=point.frame, u=point.u * scale, v=point.v * scale, cams=point.cams)
            for point in points
        ]
    events = read_gt_events(run_dir / "gt_events.csv")
    masks = {
        cam: read_mask(run_dir / "techgar_config" / f"roi_mask_{cam}.json", space)
        for cam in CAMERAS
    }
    predictions_file = predictions_path or run_dir / "m1" / "session" / "predictions.jsonl"
    predictions = read_predictions(predictions_file, obs_min_velocity=obs_min_velocity)

    recall = measure_frame_recall(cars, predictions, move_px=move_px * scale)
    per_car = measure_per_car(
        cars,
        events,
        predictions,
        masks,
        move_px=move_px * scale,
        radius=match_radius_px * scale,
    )
    return {
        "run": run_dir.name,
        "predictions": str(predictions_file),
        "image_size": [space.width, space.height],
        "s": space.scale,
        "gt_pixel_scale": scale,
        "move_px": move_px * scale,
        "match_radius_px": match_radius_px * scale,
        "masks": {
            cam: (None if mask is None else [[round(x, 2), round(y, 2)] for x, y in mask])
            for cam, mask in masks.items()
        },
        "frame_recall": recall,
        "per_car": per_car,
    }


def _fmt_percent(value: float | None) -> str:
    return "n/a" if value is None else f"{float(value) * 100:.0f} %"


def print_summary(result: dict[str, object]) -> None:
    recall = result["frame_recall"]  # type: ignore[assignment]
    per_car = result["per_car"]  # type: ignore[assignment]
    print(
        f"Run: {result['run']} · ảnh {result['image_size'][0]}×{result['image_size'][1]}"
        f" · s={result['s']} · GT×{result['gt_pixel_scale']}"
    )
    print("── Xe-frame đang chạy (GT) có observation chuyển động ──")
    for cam in CAMERAS:
        row = recall[cam]
        print(
            f"  {cam}: xe-frame đang chạy GT={row['gt_moving_frames']}"
            f"  phát hiện={row['detected_moving_frames']} ({_fmt_percent(row['detected_ratio'])})"
            f"  có GID={row['gid_frames']} ({_fmt_percent(row['gid_ratio'])})"
        )
    print("── Theo xe (chỉ đoạn tuyến trong mask cam) ──")
    print(
        f"  xe chạy đo được: {per_car['cars_measured']}/{per_car['cars_total']}"
        f" · có GID: {per_car['cars_with_gid']} ({_fmt_percent(per_car['cars_with_gid_ratio'])})"
    )
    print(
        f"  đứt track: tổng {per_car['breaks_total']}"
        f" · xe bị đứt {per_car['cars_with_breaks']} · đứt THẬT (đổi id/mất ≥{HARD_GAP_FRAMES} frame chạy) {per_car['hard_breaks_total']} (max {per_car['hard_breaks_max']})"
        f" · trung vị {per_car['breaks_median']} · max {per_car['breaks_max']}"
    )
    reuse = per_car["gid_reuse"]
    if reuse:
        print(f"  GID dùng cho nhiều xe: {per_car['gid_reuse_count']}")
        for item in reuse[:10]:
            print(f"    {item['gid']} → {', '.join(item['cars'])}")
    else:
        print("  GID dùng cho nhiều xe: 0")
    print("  từng xe:")
    for car in per_car["cars"]:
        if car["eligible_frames"] == 0:
            continue
        gids = ",".join(car["gids"]) if car["gids"] else "-"
        print(
            f"    {car['car']}/{car['slot'] or '-'}: frame hợp lệ {car['eligible_frames']}"
            f" · khớp {car['matched_frames']} ({_fmt_percent(car['coverage'])})"
            f" · GID {gids} · đứt {car['breaks']}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Đo track M1: recall xe-frame đang chạy + GID/đứt track theo xe."
    )
    parser.add_argument("run_dir", type=Path, help="thư mục run (có gt_frames.csv)")
    parser.add_argument(
        "predictions_pos",
        type=Path,
        nargs="?",
        help="(tuỳ chọn, giữ kiểu cũ) predictions.jsonl",
    )
    parser.add_argument(
        "--predictions",
        type=Path,
        default=None,
        help="predictions.jsonl (mặc định <RUN>/m1/session/predictions.jsonl)",
    )
    parser.add_argument(
        "--gt-scale",
        type=float,
        default=None,
        help="ép hệ số nhân _u/_v của GT (mặc định tự dò theo MANIFEST)",
    )
    parser.add_argument(
        "--move-px",
        type=float,
        default=DEFAULT_MOVE_PX,
        help=f"ngưỡng dịch chuyển tâm xe, pixel gốc (mặc định {DEFAULT_MOVE_PX})",
    )
    parser.add_argument(
        "--match-radius",
        type=float,
        default=DEFAULT_MATCH_RADIUS_PX,
        help=f"bán kính ghép GT↔observation, pixel gốc (mặc định {DEFAULT_MATCH_RADIUS_PX})",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="ghi kết quả JSON ra file này",
    )
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    run_dir: Path = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"Không thấy thư mục run: {run_dir}", file=sys.stderr)
        return 2
    predictions = args.predictions or args.predictions_pos
    if predictions is not None:
        predictions = predictions.resolve()
        if not predictions.exists():
            print(f"Không thấy predictions: {predictions}", file=sys.stderr)
            return 2

    result = evaluate_run(
        run_dir,
        predictions,
        move_px=args.move_px,
        match_radius_px=args.match_radius,
        gt_scale=args.gt_scale,
    )
    print_summary(result)
    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Đã ghi: {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

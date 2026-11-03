"""Sáu mục kiểm sau xuất (BE §6; contract C-B §10).

Không im lặng: mục nào sai thì ``ok: false`` kèm lý do cụ thể, không tự lấp dữ liệu.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import cv2
import numpy as np

from sim3d_server import config
from sim3d_server.config import DataPaths
from sim3d_server.http import ERROR_NAMES, HttpError
from sim3d_server.util import iso_utc, now_utc, parse_iso_utc

OVERLAY_TAGS = ("0", "mid", "last")


class _CheckError(Exception):
    """Một mục kiểm thất bại; chuỗi là lý do hiện thẳng trên UI."""


@dataclass(frozen=True, slots=True)
class Timing:
    export_seconds: float
    video_seconds: float
    detail: str


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise _CheckError(f"{path.name}: {type(error).__name__}: {error}") from error


def _load_scenario(run_dir: Path) -> dict[str, object]:
    path = run_dir / "scenario.sim3d.json"
    if not path.is_file():
        raise _CheckError("thiếu scenario.sim3d.json")
    data = _read_json(path)
    if not isinstance(data, dict):
        raise _CheckError("scenario.sim3d.json: phải là object")
    return data


def _scenario_duration(run_dir: Path) -> int | None:
    try:
        data = _load_scenario(run_dir)
    except _CheckError:
        return None
    duration = data.get("duration_frames")
    return duration if isinstance(duration, int) and not isinstance(duration, bool) else None


def _scenario_camera_mode(scenario: dict[str, object]) -> str:
    """``camera_mode`` của kịch bản; thiếu/không hợp lệ thì coi là 2 cam (ANSI cũ)."""
    mode = scenario.get("camera_mode")
    return mode if mode in ("1cam", "2cam") else "2cam"


def _load_csv(run_dir: Path, filename: str) -> tuple[list[str], list[dict[str, str]]]:
    path = run_dir / filename
    if not path.is_file():
        raise _CheckError(f"thiếu {filename}")
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            header = list(reader.fieldnames or [])
            rows = list(reader)
    except OSError as error:
        raise _CheckError(f"{filename}: {type(error).__name__}: {error}") from error
    return header, rows


def _load_gt_table(run_dir: Path) -> tuple[list[str], list[dict[str, str]]]:
    return _load_csv(run_dir, "gt_frames.csv")


def _load_events(run_dir: Path) -> tuple[list[str], list[dict[str, str]]]:
    return _load_csv(run_dir, "gt_events.csv")


def _count_video_frames(path: Path) -> tuple[int, float, int, int]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise _CheckError(f"{path.name}: cv2.VideoCapture không mở được")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = round(float(capture.get(cv2.CAP_PROP_FRAME_WIDTH)))
    height = round(float(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    count = 0
    while True:
        ok, _frame = capture.read()
        if not ok:
            break
        count += 1
    capture.release()
    return count, fps, width, height


def _expected_video_sizes(run_dir: Path) -> dict[str, tuple[int, int]]:
    """Cỡ video mong đợi, lấy từ ``image_size`` của config đã xuất.

    Chỉ ``raw_cam1/2.mp4`` là đầu vào TechGAR nên phải khớp ``image_size`` của
    ``parking_slots_cam*`` tương ứng (800×1280 khi hệ số phóng s=2).

    ``raw_full.mp4`` **giữ 640×640** ở mọi hệ số: BRIEF_P15 ghi nó là đầu ra "tùy", là ảnh toàn
    cảnh cho người xem chứ không vào bộ dò, nên không có ``image_size`` nào để đối chiếu — suy ra
    từ chiều cao cam sẽ sai ngay khi s≠1. Thiếu config (run 1 cam, ANS_1 A.1) thì dùng hằng số cũ.
    """
    sizes: dict[str, tuple[int, int]] = {}
    for cam in ("cam1", "cam2"):
        path = run_dir / "techgar_config" / f"parking_slots_{cam}.json"
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise _CheckError(f"{path.name}: không đọc được ({error})") from error
        width = payload.get("imageWidth")
        height = payload.get("imageHeight")
        if not isinstance(width, int) or not isinstance(height, int):
            raise _CheckError(f"{path.name}: thiếu imageWidth/imageHeight")
        sizes[cam] = (width, height)
    if not sizes:
        return dict(config.VIDEO_SIZES)
    sizes["full"] = config.VIDEO_SIZES["full"]
    return sizes


def _check_video_sync(run_dir: Path) -> str:
    """Mục 1: mp4 bắt buộc mở được, đếm frame thật = ``duration_frames`` = GT = timestamps.

    1 cam (ANS_1 A.1) chỉ có ``raw_full.mp4``; 2 cam phải có đủ full/cam1/cam2.
    """
    scenario = _load_scenario(run_dir)
    mode = _scenario_camera_mode(scenario)
    duration = scenario.get("duration_frames")
    if not isinstance(duration, int) or isinstance(duration, bool):
        raise _CheckError("scenario.sim3d.json: duration_frames không phải số nguyên")
    _gt_header, gt_rows = _load_gt_table(run_dir)
    _ts_header, ts_rows = _load_csv(run_dir, "frame_timestamps.csv")

    required = ["raw_full.mp4"]
    if mode == "2cam":
        required += ["raw_cam1.mp4", "raw_cam2.mp4"]
    missing = [name for name in required if not (run_dir / name).is_file()]
    if missing:
        raise _CheckError(f"thiếu {', '.join(missing)} (camera_mode={mode})")

    # BRIEF_P15 mục A: cỡ video phải khớp `image_size` **trong config đã xuất**
    # (techgar_config/parking_slots_cam*.json), không dùng hằng số, vì ảnh cam có hệ số
    # phóng `s` (mặc định 2 → 800×1280). Lệch thì fail rõ, kèm cả hai số.
    sizes = _expected_video_sizes(run_dir)
    problems: list[str] = []
    details: list[str] = []
    for name in required:
        path = run_dir / name
        output = path.stem.removeprefix("raw_")
        expected = sizes.get(output)
        count, fps, width, height = _count_video_frames(path)
        issues: list[str] = []
        if count != duration:
            issues.append(f"{count} frame, cần {duration}")
        if abs(fps - config.FPS) > 0.01:
            issues.append(f"fps {fps:g}, cần {config.FPS}")
        if expected is not None and (width, height) != expected:
            issues.append(f"{width}×{height}, cần {expected[0]}×{expected[1]}")
        if issues:
            problems.append(f"{path.name}: " + ", ".join(issues))
        else:
            details.append(f"{path.name}: {count} frame, {fps:g} fps, {width}×{height}")
    if len(gt_rows) != duration:
        problems.append(f"gt_frames.csv: {len(gt_rows)} dòng, cần {duration}")
    if len(ts_rows) != duration:
        problems.append(f"frame_timestamps.csv: {len(ts_rows)} dòng, cần {duration}")
    if problems:
        raise _CheckError("; ".join(problems))
    return (
        "; ".join(details)
        + f"; GT {len(gt_rows)} dòng; timestamps {len(ts_rows)} dòng"
    )


def _check_columns(run_dir: Path) -> str:
    """Mục 2: đủ 100 cột ô 0/1; mọi xe có ``_u/_v/_cams``."""
    header, rows = _load_gt_table(run_dir)
    missing = [slot for slot in config.SLOT_IDS if slot not in header]
    problems: list[str] = []
    if missing:
        problems.append(
            f"gt_frames.csv: thiếu {len(missing)} cột ô ({missing[0]}…{missing[-1]})"
        )
    bad_values: list[str] = []
    for line, row in enumerate(rows, start=2):
        for slot in config.SLOT_IDS:
            value = (row.get(slot) or "").strip()
            if value not in ("0", "1"):
                bad_values.append(f"dòng {line} {slot}={value!r}")
                break
        if len(bad_values) >= 3:
            break
    if bad_values:
        problems.append("gt_frames.csv: giá trị ô ngoài 0/1 (" + "; ".join(bad_values) + ")")

    event_header, event_rows = _load_events(run_dir)
    if "car" not in event_header:
        problems.append("gt_events.csv: thiếu cột car")
        cars: list[str] = []
    else:
        cars = sorted({row.get("car", "") for row in event_rows if row.get("car")})
    for car in cars:
        for suffix in ("_u", "_v", "_cams"):
            column = f"{car}{suffix}"
            if column not in header:
                problems.append(f"gt_frames.csv: thiếu cột {column} (xe {car})")
                break
    if problems:
        raise _CheckError("; ".join(problems))
    return (
        "gt_frames.csv: đủ 100 cột S001–S100, giá trị 0/1; "
        f"gt_events.csv có {len(cars)} xe với _u/_v/_cams"
    )


def _check_event_order(run_dir: Path) -> str:
    """Mục 3: ``gate_in ≤ parked ≤ depart ≤ gate_out`` ở mọi dòng."""
    _header, rows = _load_events(run_dir)
    columns = ("gate_in_frame", "parked_frame", "depart_frame", "gate_out_frame")
    for line, row in enumerate(rows, start=2):
        frames: list[tuple[str, int]] = []
        for column in columns:
            raw = (row.get(column) or "").strip()
            if not raw:
                continue
            try:
                frames.append((column, int(raw)))
            except ValueError as error:
                raise _CheckError(
                    f"gt_events.csv dòng {line}: {column}={raw!r} không phải số nguyên"
                ) from error
        for (name_a, frame_a), (name_b, frame_b) in pairwise(frames):
            if frame_a > frame_b:
                raise _CheckError(
                    f"gt_events.csv dòng {line}: {name_a}={frame_a} > {name_b}={frame_b}"
                )
    return f"gt_events.csv: {len(rows)} dòng đúng thứ tự gate_in ≤ parked ≤ depart ≤ gate_out"


def _check_techgar_config(run_dir: Path) -> str:
    """Mục 4: đủ file, JSON parse được, mỗi file slot có 1–100 ô S001–S100.

    1 cam không xuất ``techgar_config/`` (ANS_1 A.1: TechGAR bắt buộc 2 cam) nên mục
    này là "không áp dụng", vẫn ``ok: true`` với detail riêng; 2 cam giữ nguyên.
    """
    scenario = _load_scenario(run_dir)
    if _scenario_camera_mode(scenario) == "1cam":
        return "1 cam: không xuất techgar_config (ANS_1 A.1)"
    base = run_dir / "techgar_config"
    missing = [name for name in config.TECHGAR_REQUIRED_FILES if not (base / name).is_file()]
    if missing:
        raise _CheckError(f"techgar_config: thiếu {', '.join(missing)}")
    details: list[str] = []
    for name in config.TECHGAR_JSON_FILES:
        data = _read_json(base / name)
        if name in config.TECHGAR_SLOT_FILES:
            slots = data.get("slots") if isinstance(data, dict) else None
            if not isinstance(slots, list):
                raise _CheckError(f"techgar_config/{name}: thiếu mảng slots")
            if not 1 <= len(slots) <= 100:
                raise _CheckError(f"techgar_config/{name}: có {len(slots)} ô, cần 1–100")
            for slot in slots:
                slot_id = slot.get("id") if isinstance(slot, dict) else None
                if slot_id not in config.SLOT_ID_SET:
                    raise _CheckError(
                        f"techgar_config/{name}: id ô {slot_id!r} ngoài S001–S100"
                    )
            details.append(f"{name}: {len(slots)} ô")
    return "techgar_config: đủ file, 7 JSON parse được; " + ", ".join(details)


def _load_lot_polygons(paths: DataPaths) -> dict[str, list[list[float]]]:
    path = paths.lot_file
    if not path.is_file():
        raise _CheckError(f"chưa có {config.LOT_DIRNAME}/{config.LOT_PUCPR_FILENAME} để vẽ ô")
    data = _read_json(path)
    slots = data.get("slots") if isinstance(data, dict) else None
    if not isinstance(slots, list):
        raise _CheckError(f"{path.name}: thiếu mảng slots")
    polygons: dict[str, list[list[float]]] = {}
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        slot_id = slot.get("id")
        polygon = slot.get("polygon_px")
        if isinstance(slot_id, str) and isinstance(polygon, list):
            polygons[slot_id] = polygon
    return polygons


def _check_overlays(paths: DataPaths, run_dir: Path) -> str:
    """Mục 5: vẽ đa giác ô có xe theo GT lên 3 frame (đầu/giữa/cuối)."""
    video = run_dir / "raw_full.mp4"
    if not video.is_file():
        raise _CheckError("không có raw_full.mp4 để vẽ overlay")
    polygons = _load_lot_polygons(paths)
    _header, rows = _load_gt_table(run_dir)
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        capture.release()
        raise _CheckError("raw_full.mp4: cv2.VideoCapture không mở được")
    total = round(float(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    if total <= 0:
        capture.release()
        raise _CheckError("raw_full.mp4: không đọc được tổng số frame")
    targets = ((0, "0"), (total // 2, "mid"), (total - 1, "last"))
    written: list[str] = []
    for index, tag in targets:
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok:
            capture.release()
            raise _CheckError(f"raw_full.mp4: không đọc được frame {index}")
        if index >= len(rows):
            capture.release()
            raise _CheckError(f"gt_frames.csv: thiếu dòng cho frame {index}")
        row = rows[index]
        for slot_id in config.SLOT_IDS:
            if (row.get(slot_id) or "").strip() != "1":
                continue
            polygon = polygons.get(slot_id)
            if polygon is None:
                capture.release()
                raise _CheckError(f"lot_pucpr.json: không có polygon_px của ô {slot_id}")
            points = np.array(polygon, dtype=np.float32)
            points = np.round(points).astype(np.int32).reshape(-1, 2)
            cv2.polylines(frame, [points], True, (0, 0, 255), 2)
            corner = (int(points[0][0]), int(points[0][1]))
            cv2.putText(
                frame,
                slot_id,
                corner,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 0),
                1,
                cv2.LINE_AA,
            )
        destination = run_dir / f"verify_overlay_{tag}.jpg"
        if not cv2.imwrite(str(destination), frame):
            capture.release()
            raise _CheckError(f"không ghi được {destination.name}")
        written.append(destination.name)
    capture.release()
    return ", ".join(written)


def _measure_timing(run_dir: Path, elapsed_seconds: float) -> Timing:
    """Mục 6: thời gian xuất và tỉ lệ so với thời gian thực."""
    export_seconds = float(elapsed_seconds)
    log_path = run_dir / "export_log.json"
    if log_path.is_file():
        data = _read_json(log_path)
        if isinstance(data, dict):
            started = data.get("started_at")
            finished = data.get("finished_at")
            if isinstance(started, str) and isinstance(finished, str):
                delta = (parse_iso_utc(finished) - parse_iso_utc(started)).total_seconds()
                if delta >= 0:
                    export_seconds = delta
    duration = _scenario_duration(run_dir)
    video_seconds = duration / config.FPS if duration else 0.0
    ratio = video_seconds / export_seconds if export_seconds > 0 else 0.0
    detail = (
        f"xuất {export_seconds:.1f} s cho {video_seconds:.1f} s video "
        f"(tỉ lệ {ratio:.2f}× thời gian thực)"
    )
    return Timing(export_seconds=export_seconds, video_seconds=video_seconds, detail=detail)


def verify_run(paths: DataPaths, run_id: str, elapsed_seconds: float) -> dict[str, object]:
    """Chạy 6 mục kiểm, ghi và trả ``verify.json`` (BE §6)."""
    run_dir = paths.runs_dir / run_id
    if not run_dir.is_dir():
        raise HttpError(404, ERROR_NAMES[404], f'không có lần xuất "{run_id}"')

    checks = (
        (1, lambda: _check_video_sync(run_dir)),
        (2, lambda: _check_columns(run_dir)),
        (3, lambda: _check_event_order(run_dir)),
        (4, lambda: _check_techgar_config(run_dir)),
        (5, lambda: _check_overlays(paths, run_dir)),
    )
    items: list[dict[str, object]] = []
    for item_id, check in checks:
        try:
            items.append({"id": item_id, "ok": True, "detail": check()})
        except _CheckError as error:
            items.append({"id": item_id, "ok": False, "detail": str(error)})
        except Exception as error:  # noqa: BLE001 - lỗi lập trình vẫn phải hiện, không nuốt (R2)
            items.append(
                {"id": item_id, "ok": False, "detail": f"{type(error).__name__}: {error}"}
            )

    try:
        timing = _measure_timing(run_dir, elapsed_seconds)
        items.append({"id": 6, "ok": True, "detail": timing.detail})
    except Exception as error:  # noqa: BLE001 - ghi lý do vào verify, không nuốt (R2)
        timing = Timing(export_seconds=float(elapsed_seconds), video_seconds=0.0, detail="")
        items.append(
            {"id": 6, "ok": False, "detail": f"{type(error).__name__}: {error}"}
        )

    ratio = timing.video_seconds / timing.export_seconds if timing.export_seconds > 0 else 0.0
    report: dict[str, object] = {
        "ok": all(bool(item["ok"]) for item in items),
        "run_id": run_id,
        "generated_at": iso_utc(now_utc()),
        "items": items,
        "export_seconds": round(timing.export_seconds, 1),
        "realtime_ratio": round(ratio, 2),
    }
    (run_dir / "verify.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report

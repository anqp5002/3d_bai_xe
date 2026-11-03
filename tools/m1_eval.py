"""Đo M1 động (P10a): occupancy theo frame + độ trễ đổi trạng thái, so với GT của run.

Phân công P10a: script này **chỉ** làm occupancy và độ trễ; phần đếm cổng do
``sim3d/tools/m1_gate_eval.py`` (coders-1) đảm nhiệm, ghi vào ``<RUN_DIR>/m1_gate/``. Vì vậy ở
đây **không** chạy ``gate_session_controller`` và không chiếm cổng 8001 mặc định.

Chạy::

    python sim3d/tools/m1_eval.py <RUN_DIR>              # replay rồi đánh giá
    python sim3d/tools/m1_eval.py <RUN_DIR> --skip-run   # đánh giá từ predictions có sẵn

Ghi vào ``<RUN_DIR>/m1/`` (không ghi ra ngoài thư mục run):

- ``replay_log.txt``   log runtime replay (khi chạy mới)
- ``metrics.json``     số liệu tổng hợp
- ``mismatches.csv``   từng ca lệch (frame, ô, GT, TechGAR, loại)
- ``latency.csv``      từng ca đo độ trễ đổi trạng thái

Nguồn dữ liệu
-------------
- TechGAR: ``m1/session/predictions.jsonl`` — mỗi dòng 1 frame, trường ``slots`` là **list** các
  dict ``{camera_id, slot_id, occupied, ...}`` (mỗi ô xuất hiện 1 lần cho mỗi camera đang thấy nó).
  Frame đầu ``slots`` rỗng (vision chưa xong) nên **loại khỏi** mẫu số, không tính là báo trống.
- GT: ``gt_frames.csv`` (cột ``frame`` + S001…S100, 1 = có xe).
- GT sự kiện: ``gt_events.csv`` (``parked_frame`` 0→1, ``depart_frame`` 1→0).

Điều kiện đạt phần này (ANS_7): % frame-ô đúng ≥ 95 %.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
REPO_DIR: Final = SIM3D_DIR.parent
VENV_PYTHON: Final = REPO_DIR / "backend" / "main_detect" / ".venv" / "Scripts" / "python.exe"
MAIN_DETECT_DIR: Final = REPO_DIR / "backend" / "main_detect"

#: Ngưỡng đạt (ANS_7).
PASS_FRAME_SLOT_ACCURACY: Final = 0.95

#: Cổng API mặc định của script này. Cố ý khác 8001 để không đụng lần chạy gate của coders-1.
DEFAULT_API_PORT: Final = 8011

SLOT_IDS: Final = tuple(f"S{i:03d}" for i in range(1, 101))


# ---------------------------------------------------------------------------------------
# Đọc dữ liệu
# ---------------------------------------------------------------------------------------
def read_gt_frames(path: Path) -> dict[int, dict[str, int]]:
    """``gt_frames.csv`` → ``{frame: {slot: 0|1}}``."""
    out: dict[int, dict[str, int]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            frame = int(row["frame"])
            out[frame] = {slot: int(row[slot]) for slot in SLOT_IDS if slot in row}
    return out


@dataclass
class GtEvent:
    car: str
    slot: str
    gate_in_frame: int | None
    parked_frame: int | None
    depart_frame: int | None
    gate_out_frame: int | None


def _maybe_int(value: str | None) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    return int(float(value))


def read_gt_events(path: Path) -> list[GtEvent]:
    """``gt_events.csv`` → danh sách sự kiện."""
    out: list[GtEvent] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            out.append(
                GtEvent(
                    car=row["car"],
                    slot=row["slot"],
                    gate_in_frame=_maybe_int(row.get("gate_in_frame")),
                    parked_frame=_maybe_int(row.get("parked_frame")),
                    depart_frame=_maybe_int(row.get("depart_frame")),
                    gate_out_frame=_maybe_int(row.get("gate_out_frame")),
                )
            )
    return out


@dataclass
class FramePrediction:
    frame: int
    #: ``slot -> occupied`` gộp từ các camera báo ô đó.
    occupied: dict[str, bool]
    #: Các ô TechGAR thực sự đã báo trong frame (mẫu số hợp lệ).
    seen: set[str]


def read_predictions(path: Path) -> list[FramePrediction]:
    """``predictions.jsonl`` → danh sách frame (gộp ``occupied`` của mọi camera theo OR).

    OR giữa các camera: ô bị bất kỳ camera nào báo có xe thì coi là có xe — đúng quy ước M1 đã
    dùng khi so trạng thái cuối.
    """
    out: list[FramePrediction] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            occupied: dict[str, bool] = {}
            seen: set[str] = set()
            for entry in record.get("slots") or []:
                slot = str(entry.get("slot_id"))
                if slot not in SLOT_IDS:
                    continue
                occupied[slot] = occupied.get(slot, False) or bool(entry.get("occupied"))
                seen.add(slot)
            out.append(
                FramePrediction(
                    frame=int(record["frame_idx"]),
                    occupied=occupied,
                    seen=seen,
                )
            )
    return out


# ---------------------------------------------------------------------------------------
# Đo occupancy
# ---------------------------------------------------------------------------------------
@dataclass
class OccupancyResult:
    total: int = 0
    correct: int = 0
    false_free: int = 0
    false_occupied: int = 0
    per_slot_total: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    per_slot_correct: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    #: ``(frame, slot, gt, techgar, kind)`` với kind ∈ {false_free, false_occupied}
    mismatches: list[tuple[int, str, int, int, str]] = field(default_factory=list)

    @property
    def accuracy(self) -> float:
        return 0.0 if self.total == 0 else self.correct / self.total


def measure_occupancy(
    predictions: list[FramePrediction],
    gt_frames: dict[int, dict[str, int]],
) -> OccupancyResult:
    """So từng frame-ô giữa TechGAR và GT.

    Chỉ tính những ô mà TechGAR **đã báo** trong frame đó (``seen``): frame chưa có kết quả
    vision mà tính là "báo trống" sẽ tạo sai số giả tạo.
    """
    result = OccupancyResult()
    for prediction in predictions:
        gt = gt_frames.get(prediction.frame)
        if gt is None:
            continue
        for slot in sorted(prediction.seen):
            if slot not in gt:
                continue
            truth = gt[slot]
            predicted = 1 if prediction.occupied.get(slot, False) else 0
            result.total += 1
            result.per_slot_total[slot] += 1
            if truth == predicted:
                result.correct += 1
                result.per_slot_correct[slot] += 1
                continue
            if truth == 1:
                result.false_free += 1
                kind = "false_free"
            else:
                result.false_occupied += 1
                kind = "false_occupied"
            result.mismatches.append((prediction.frame, slot, truth, predicted, kind))
    return result


# ---------------------------------------------------------------------------------------
# Đo độ trễ đổi trạng thái
# ---------------------------------------------------------------------------------------
@dataclass
class LatencyCase:
    car: str
    slot: str
    kind: str  # "park" | "depart"
    gt_frame: int
    techgar_frame: int | None
    delay: int | None

    @property
    def early(self) -> bool:
        """TechGAR đổi trạng thái **trước** mốc GT."""
        return self.delay is not None and self.delay < 0


@dataclass
class LatencyResult:
    cases: list[LatencyCase] = field(default_factory=list)
    #: Số ca GT có mốc nhưng TechGAR không có chuyển trạng thái trong cửa sổ tìm kiếm.
    missing: int = 0
    #: Số ca GT có mốc nhưng nằm ngoài dải frame có dữ liệu (không đo được).
    out_of_range: int = 0

    def delays(self, kind: str) -> list[int]:
        return [
            case.delay for case in self.cases if case.kind == kind and case.delay is not None
        ]


def _transitions(
    predictions: list[FramePrediction],
) -> dict[str, list[tuple[int, bool]]]:
    """``slot -> [(frame, occupied)]`` chỉ tại các frame **đổi** trạng thái."""
    timeline: dict[str, list[tuple[int, bool]]] = defaultdict(list)
    for prediction in predictions:
        for slot in prediction.seen:
            timeline[slot].append((prediction.frame, prediction.occupied.get(slot, False)))
    out: dict[str, list[tuple[int, bool]]] = {}
    for slot, samples in timeline.items():
        samples.sort()
        changes: list[tuple[int, bool]] = []
        previous: bool | None = None
        for frame, occupied in samples:
            if occupied != previous:
                changes.append((frame, occupied))
                previous = occupied
        out[slot] = changes
    return out


def measure_latency(
    predictions: list[FramePrediction],
    events: list[GtEvent],
    *,
    search_window: int = 500,
) -> LatencyResult:
    """Độ trễ (frame) của lần đổi trạng thái **gần mốc GT nhất**, có thể âm (báo sớm).

    - ``parked_frame`` (GT 0→1): so với lần TechGAR chuyển sang occupied.
    - ``depart_frame`` (GT 1→0): so với lần TechGAR chuyển sang trống.

    Chọn chuyển trạng thái gần mốc GT nhất trong ``±search_window`` frame, thay vì chỉ tìm về
    phía sau: ``gt_frames.csv`` (hình học ô) và ``gt_events.csv`` (mốc trạng thái) lệch nhau vài
    chục frame, nên cách "chờ qua mốc" sẽ báo trễ 0 và che mất việc TechGAR báo sớm.
    """
    result = LatencyResult()
    if not predictions:
        return result
    frames = sorted(prediction.frame for prediction in predictions)
    first_frame, last_frame = frames[0], frames[-1]
    transitions = _transitions(predictions)

    for event in events:
        for kind, gt_frame, want in (
            ("park", event.parked_frame, True),
            ("depart", event.depart_frame, False),
        ):
            if gt_frame is None:
                continue
            if not first_frame <= gt_frame <= last_frame:
                result.out_of_range += 1
                continue
            candidates = [
                (frame, occupied)
                for frame, occupied in transitions.get(event.slot, ())
                if occupied == want and abs(frame - gt_frame) <= search_window
            ]
            hit = (
                min(candidates, key=lambda item: (abs(item[0] - gt_frame), item[0]))[0]
                if candidates
                else None
            )
            result.cases.append(
                LatencyCase(
                    car=event.car,
                    slot=event.slot,
                    kind=kind,
                    gt_frame=gt_frame,
                    techgar_frame=hit,
                    delay=None if hit is None else hit - gt_frame,
                )
            )
            if hit is None:
                result.missing += 1
    return result


def gt_frame_transitions(gt_frames: dict[int, dict[str, int]]) -> dict[str, list[tuple[int, int]]]:
    """``slot -> [(frame, 0|1)]`` tại các frame GT đổi trạng thái trong ``gt_frames.csv``."""
    out: dict[str, list[tuple[int, int]]] = {}
    for slot in SLOT_IDS:
        changes: list[tuple[int, int]] = []
        previous: int | None = None
        for frame in sorted(gt_frames):
            value = gt_frames[frame].get(slot)
            if value is None:
                continue
            if value != previous:
                changes.append((frame, value))
                previous = value
        if changes:
            out[slot] = changes
    return out


def measure_latency_vs_frames(
    predictions: list[FramePrediction],
    gt_frames: dict[int, dict[str, int]],
    events: list[GtEvent],
    *,
    search_window: int = 500,
) -> list[LatencyCase]:
    """Độ trễ đo theo **hình học ô** (``gt_frames.csv``) thay vì mốc ``gt_events.csv``.

    ``gt_frames.csv`` (xe có nằm trong polygon ô hay không) và ``gt_events.csv`` (mốc trạng thái
    do scenario phát) lệch nhau vài chục frame trên các run này. Đo cả hai để biết độ trễ phụ
    thuộc mốc nào, thay vì chỉ tin một nguồn.
    """
    cases: list[LatencyCase] = []
    if not predictions:
        return cases
    frames = sorted(prediction.frame for prediction in predictions)
    first_frame, last_frame = frames[0], frames[-1]
    predicted = _transitions(predictions)
    truth = gt_frame_transitions(gt_frames)

    for event in events:
        if event.parked_frame is None and event.depart_frame is None:
            continue
        for kind, want, gt_value in (("park", True, 1), ("depart", False, 0)):
            gt_changes = truth.get(event.slot, [])
            marks = [
                frame
                for index, (frame, value) in enumerate(gt_changes)
                if value == gt_value and index > 0
            ]
            if not marks:
                continue
            candidates = [
                (frame, occupied)
                for frame, occupied in predicted.get(event.slot, ())
                if occupied == want
            ]
            if not candidates:
                cases.append(
                    LatencyCase(
                        car=event.car,
                        slot=event.slot,
                        kind=kind,
                        gt_frame=marks[0],
                        techgar_frame=None,
                        delay=None,
                    )
                )
                continue
            # Ghép mỗi mốc GT với lần TechGAR đổi gần nhất trong cùng cửa sổ.
            for mark in marks:
                if not first_frame <= mark <= last_frame:
                    continue
                nearby = [
                    frame for frame, _ in candidates if abs(frame - mark) <= search_window
                ]
                hit = min(nearby, key=lambda frame: (abs(frame - mark), frame)) if nearby else None
                cases.append(
                    LatencyCase(
                        car=event.car,
                        slot=event.slot,
                        kind=kind,
                        gt_frame=mark,
                        techgar_frame=hit,
                        delay=None if hit is None else hit - mark,
                    )
                )
    return cases


def _stats(values: list[int]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "median": None, "max": None}
    ordered = sorted(values)
    middle = len(ordered) // 2
    median = (
        float(ordered[middle])
        if len(ordered) % 2 == 1
        else (ordered[middle - 1] + ordered[middle]) / 2.0
    )
    return {"count": len(values), "median": median, "max": ordered[-1]}


# ---------------------------------------------------------------------------------------
# Chạy replay
# ---------------------------------------------------------------------------------------
def replay_command(run_dir: Path, *, api_port: int) -> list[str]:
    """Lệnh replay y như ``REPORT_M1`` (đường tuyệt đối, venv của backend)."""
    config = run_dir / "techgar_config"
    return [
        str(VENV_PYTHON),
        "runtime_server.py",
        "--replay-session",
        str(run_dir),
        "--slots-cam1",
        str(config / "parking_slots_cam1.json"),
        "--slots-cam2",
        str(config / "parking_slots_cam2.json"),
        "--calibration",
        str(config / "calibration.json"),
        "--mask-cam1",
        str(config / "roi_mask_cam1.json"),
        "--mask-cam2",
        str(config / "roi_mask_cam2.json"),
        "--detector-profile",
        "config/two_camera.detector.json",
        "--output-dir",
        str(run_dir / "m1" / "runtime"),
        "--session-dir",
        str(run_dir / "m1" / "session"),
        "--api-port",
        str(api_port),
        "--no-display",
    ]


def run_replay(run_dir: Path, *, api_port: int) -> dict[str, object]:
    """Chạy replay. Trả ``{ok, returncode, command, log_path, error?}``."""
    m1_dir = run_dir / "m1"
    m1_dir.mkdir(parents=True, exist_ok=True)
    log_path = m1_dir / "replay_log.txt"
    info: dict[str, object] = {"log_path": str(log_path)}

    if not VENV_PYTHON.exists():
        info.update(ok=False, error=f"không có python venv: {VENV_PYTHON}")
        return info

    # two_camera.py ném FileExistsError nếu session-dir đã tồn tại.
    for generated in (m1_dir / "session", m1_dir / "runtime"):
        if generated.exists():
            shutil.rmtree(generated)

    command = replay_command(run_dir, api_port=api_port)
    info["command"] = command
    completed = subprocess.run(
        command,
        cwd=str(MAIN_DETECT_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    log_path.write_text(
        (completed.stdout or "") + (completed.stderr or ""), encoding="utf-8"
    )
    info.update(ok=completed.returncode == 0, returncode=completed.returncode)
    return info


# ---------------------------------------------------------------------------------------
# Tổng hợp
# ---------------------------------------------------------------------------------------
def measure_track(run_dir: Path, predictions_path: Path) -> dict[str, object]:
    """Gọi ``m1_track_eval`` (P15b) để lấy mục track; lỗi không làm hỏng phần occupancy."""
    if str(TOOLS_DIR) not in sys.path:
        sys.path.insert(0, str(TOOLS_DIR))
    try:
        import m1_track_eval
    except ImportError as error:  # pragma: no cover - chỉ xảy ra khi thiếu file
        return {"error": f"không import được m1_track_eval: {error}"}
    try:
        return m1_track_eval.evaluate_run(run_dir, predictions_path)
    except (OSError, ValueError, KeyError) as error:
        return {"error": f"{type(error).__name__}: {error}"}


def evaluate(run_dir: Path, run_note: str, *, latency_window: int = 500) -> dict[str, object]:
    m1_dir = run_dir / "m1"
    predictions = read_predictions(m1_dir / "session" / "predictions.jsonl")
    gt_frames = read_gt_frames(run_dir / "gt_frames.csv")
    events = read_gt_events(run_dir / "gt_events.csv")

    occupancy = measure_occupancy(predictions, gt_frames)
    latency = measure_latency(predictions, events, search_window=latency_window)
    latency_frames = measure_latency_vs_frames(
        predictions, gt_frames, events, search_window=latency_window
    )

    per_slot_accuracy = {
        slot: (
            occupancy.per_slot_correct[slot] / occupancy.per_slot_total[slot]
            if occupancy.per_slot_total[slot]
            else None
        )
        for slot in SLOT_IDS
    }
    worst_slots = sorted(
        (
            (slot, value)
            for slot, value in per_slot_accuracy.items()
            if value is not None and value < 1.0
        ),
        key=lambda pair: pair[1],
    )[:10]

    mismatched_slots = sorted({slot for _, slot, *_ in occupancy.mismatches})

    metrics: dict[str, object] = {
        "run": run_dir.name,
        "frames_evaluated": len(predictions),
        "gt_frames": len(gt_frames),
        "occupancy": {
            "frame_slot_total": occupancy.total,
            "correct": occupancy.correct,
            "accuracy": round(occupancy.accuracy, 6),
            "false_free": occupancy.false_free,
            "false_occupied": occupancy.false_occupied,
            "mismatched_slots": mismatched_slots,
            "worst_slots": [
                {"slot": slot, "accuracy": round(value, 4)} for slot, value in worst_slots
            ],
        },
        "latency_frames": {
            "reference": "gt_events.csv (mốc trạng thái)",
            "park": _stats(latency.delays("park")),
            "depart": _stats(latency.delays("depart")),
            "missing_transitions": latency.missing,
            "out_of_range": latency.out_of_range,
            "early_transitions": sum(1 for case in latency.cases if case.early),
            "cases": [
                {
                    "car": case.car,
                    "slot": case.slot,
                    "kind": case.kind,
                    "gt_frame": case.gt_frame,
                    "techgar_frame": case.techgar_frame,
                    "delay_frames": case.delay,
                    "early": case.early,
                }
                for case in latency.cases
            ],
        },
        "latency_vs_gt_frames": {
            "reference": "gt_frames.csv (hình học ô)",
            "park": _stats(
                [case.delay for case in latency_frames if case.kind == "park" and case.delay is not None]
            ),
            "depart": _stats(
                [case.delay for case in latency_frames if case.kind == "depart" and case.delay is not None]
            ),
            "cases": [
                {
                    "car": case.car,
                    "slot": case.slot,
                    "kind": case.kind,
                    "gt_frame": case.gt_frame,
                    "techgar_frame": case.techgar_frame,
                    "delay_frames": case.delay,
                }
                for case in latency_frames
            ],
        },
        "gate_counting": {
            "measured_here": False,
            "owner": "sim3d/tools/m1_gate_eval.py (coders-1) → <RUN_DIR>/m1_gate/",
        },
        "track": measure_track(run_dir, m1_dir / "session" / "predictions.jsonl"),
        "pass": {
            "frame_slot_accuracy": occupancy.accuracy >= PASS_FRAME_SLOT_ACCURACY,
        },
        "note": run_note,
    }

    mismatch_path = m1_dir / "mismatches.csv"
    with mismatch_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["frame", "slot", "gt", "techgar", "kind"])
        for row in occupancy.mismatches:
            writer.writerow(row)

    latency_path = m1_dir / "latency.csv"
    with latency_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["car", "slot", "kind", "gt_frame", "techgar_frame", "delay_frames"])
        for case in latency.cases:
            writer.writerow(
                [case.car, case.slot, case.kind, case.gt_frame, case.techgar_frame, case.delay]
            )

    metrics["mismatches_csv"] = str(mismatch_path)
    metrics["mismatch_rows"] = len(occupancy.mismatches)
    metrics["latency_csv"] = str(latency_path)

    (m1_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return metrics


def _fmt_percent(value: float | int | None) -> str:
    return "n/a" if value is None else f"{float(value) * 100:.2f} %"


def print_summary(metrics: dict[str, object]) -> None:
    occupancy = metrics["occupancy"]  # type: ignore[assignment]
    latency = metrics["latency_frames"]  # type: ignore[assignment]
    passed = metrics["pass"]  # type: ignore[assignment]

    print(f"Run: {metrics['run']} · frame đánh giá: {metrics['frames_evaluated']}")
    print("── Occupancy theo frame ──")
    print(
        f"  frame-ô: {occupancy['frame_slot_total']} · đúng {occupancy['correct']}"
        f" = {_fmt_percent(occupancy['accuracy'])} (ngưỡng ≥ {PASS_FRAME_SLOT_ACCURACY * 100:.0f} %)"
    )
    print(
        f"  false-free {occupancy['false_free']} · false-occupied {occupancy['false_occupied']}"
        f" · ca lệch {metrics.get('mismatch_rows')}"
    )
    if occupancy["mismatched_slots"]:
        print("  ô có lệch: " + ", ".join(occupancy["mismatched_slots"]))
    worst = occupancy["worst_slots"]
    if worst:
        print(
            "  ô kém nhất: "
            + ", ".join(f"{item['slot']} {_fmt_percent(item['accuracy'])}" for item in worst[:5])
        )
    print("── Độ trễ đổi trạng thái (frame) ──")
    for name in ("park", "depart"):
        stats = latency[name]
        if stats["count"] == 0:
            print(f"  {name}: không có ca đo được")
        else:
            print(
                f"  {name}: n={stats['count']} · trung vị {stats['median']} · max {stats['max']}"
                "  (mốc gt_events.csv)"
            )
    if latency["missing_transitions"]:
        print(f"  ca không thấy chuyển trạng thái: {latency['missing_transitions']}")
    if latency["early_transitions"]:
        print(f"  ca báo sớm hơn GT (trễ âm): {latency['early_transitions']}")
    for case in latency["cases"]:
        if case["delay_frames"] is None:
            delay = "không thấy chuyển trạng thái"
        elif case["delay_frames"] < 0:
            delay = f"sớm {-case['delay_frames']} frame"
        else:
            delay = f"trễ {case['delay_frames']} frame"
        print(
            f"    {case['car']}/{case['slot']} {case['kind']}: GT {case['gt_frame']}"
            f" → TechGAR {case['techgar_frame']} ({delay})"
        )
    print("── Track (m1_track_eval, P15b) ──")
    track = metrics.get("track") or {}
    if track.get("error"):
        print(f"  KHÔNG đo được: {track['error']}")
    elif not track:
        print("  KHÔNG có dữ liệu track")
    else:
        for cam, row in track["frame_recall"].items():
            print(
                f"  {cam}: xe-frame đang chạy GT={row['gt_moving_frames']}"
                f" · phát hiện {_fmt_percent(row['detected_ratio'])}"
                f" · có GID {_fmt_percent(row['gid_ratio'])}"
            )
        per_car = track["per_car"]
        print(
            f"  xe chạy đo được {per_car['cars_measured']}/{per_car['cars_total']}"
            f" · có GID {_fmt_percent(per_car['cars_with_gid_ratio'])}"
            f" · đứt track tổng {per_car['breaks_total']}"
            f" · GID dùng lại {per_car['gid_reuse_count']}"
        )
    print("── Cổng ──")
    print("  KHÔNG đo ở script này: coders-1 chạy m1_gate_eval.py → <RUN_DIR>/m1_gate/")
    if metrics.get("note"):
        print(f"  ghi chú: {metrics['note']}")
    print(
        f"KẾT LUẬN occupancy: "
        f"{'ĐẠT' if passed['frame_slot_accuracy'] else 'KHÔNG ĐẠT'}"
        f" (ngưỡng ≥ {PASS_FRAME_SLOT_ACCURACY * 100:.0f} %)"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Đo occupancy + độ trễ M1 trên một run sim3d.")
    parser.add_argument("run_dir", type=Path, help="thư mục run (có gt_frames.csv)")
    parser.add_argument(
        "--skip-run",
        action="store_true",
        help="không chạy replay, đánh giá từ m1/session/predictions.jsonl có sẵn",
    )
    parser.add_argument(
        "--api-port",
        type=int,
        default=DEFAULT_API_PORT,
        help=f"cổng API của runtime replay (mặc định {DEFAULT_API_PORT}, tránh 8001 của coders-1)",
    )
    parser.add_argument(
        "--latency-window",
        type=int,
        default=500,
        help="bán kính (frame) khi tìm chuyển trạng thái gần mốc GT nhất; mặc định 500",
    )
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    run_dir: Path = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"Không thấy thư mục run: {run_dir}", file=sys.stderr)
        return 2
    m1_dir = run_dir / "m1"
    m1_dir.mkdir(parents=True, exist_ok=True)

    if args.skip_run:
        note = "dùng predictions có sẵn (--skip-run)"
    else:
        replay = run_replay(run_dir, api_port=args.api_port)
        if replay.get("error"):
            print(f"Không chạy được replay: {replay['error']}", file=sys.stderr)
            return 2
        note = (
            f"replay {'OK' if replay['ok'] else 'LỖI'}"
            f" (returncode={replay['returncode']}, api-port {args.api_port}) → replay_log.txt"
        )
        print(f"Replay: {note}")
        if not replay["ok"]:
            print(f"  lệnh: {' '.join(replay['command'])}")  # type: ignore[arg-type]

    predictions_path = m1_dir / "session" / "predictions.jsonl"
    if not predictions_path.exists():
        print(
            f"Không thấy {predictions_path} — cần chạy replay trước (bỏ --skip-run).",
            file=sys.stderr,
        )
        return 2

    metrics = evaluate(run_dir, note, latency_window=args.latency_window)
    print_summary(metrics)
    print(
        f"Đã ghi: {m1_dir / 'metrics.json'} · {m1_dir / 'mismatches.csv'}"
        f" · {m1_dir / 'latency.csv'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Baseline video thật cho P16 (SPEC_P16 R4): replay + controller + đếm sự kiện.

Mục đích
--------
Chạy lại **cùng một lệnh** trước và sau khi sửa backend, ghi ra JSON so sánh được:

- số GID mới (``global_id_created``);
- số lần ``[merge]`` (các event merge đã hoàn tất);
- số lần ``[re-id]`` (các event recovery/reid, KHÔNG gồm handoff);
- số ``[handoff]`` mở/khớp/từ chối;
- occupancy theo ô (đo được kể cả khi không có GT — GT hiện rỗng ở mọi session);
- số ``[ENTRY]``/``[EXIT]`` do ``gate_session_controller`` in ra.

Nguồn số
--------
- ``predictions.jsonl`` của runtime replay (schema v3) → ``identity_events``,
  ``observations``, ``slots``.
- stdout ``gate_session_controller.py`` → ``[ENTRY]``/``[EXIT]`` (parse bằng
  ``m1_gate_eval.parse_controller_log``, bản đã sửa mất log: ``-u`` +
  ``PYTHONUNBUFFERED``).

Vì sao dùng ``--replay-session``
--------------------------------
``runtime_server.py`` **không có** ``--cam1-video/--cam2-video``. Cờ đúng là
``--replay-session <thư mục có raw_cam1.mp4, raw_cam2.mp4, frame_timestamps.csv>``
(xem ``sim3d/README.md`` mục C và ``backend/main_detect/docs/lenh-chay-theo-session.md``).

Cấu hình theo session — hai bộ, kết quả rất khác nhau
-----------------------------------------------------
``--config-set`` chọn bộ config đưa vào replay:

- ``session`` (mặc định): ``config/sessions/droidcam_shared_*``. Đây là bản
  "recovered" dựng lại **sau** khi quay (``MANIFEST.json`` ghi
  ``calibration: recovered_cal``), nên không chắc khớp lúc quay.
- ``root``: bộ gốc ``config/`` (``two_camera.shared_cm_01.json`` +
  ``parking_slots_cam*`` + ``roi_mask_cam*``). Đây **chính là bộ đã dùng lúc
  quay** theo ``session_info.json`` của video và là bộ mà replay chuẩn
  ``.analysis/verify-replay`` dùng cho cả 18 session.

Đo thử ``session_hiep2`` (642 frame) cho thấy lựa chọn này đổi hẳn kết quả:

| calibration | mask | số GID |
|---|---|---|
| session | session | 7 |
| session | root | 4 |
| root | root | 2 |

⇒ Luôn ghi rõ ``config_set`` trong JSON/report; **không** so số giữa hai bộ.

``gate_zones.json``: **không có** bản theo session trong repo; chỉ có
``backend/main_detect/config/gate_zones.json`` (map live, đơn vị cm). Script dùng
bản đó cho cả hai bộ config và ghi rõ cảnh báo trong JSON/report — đây là giả
định, không phải config theo era.

Ví dụ
-----
Baseline "before" bằng bộ config lúc quay (khuyến nghị, so sánh được với
replay chuẩn) — ``--legacy-departure-token-distance`` để tắt fix P16c đang có
sẵn trong worktree::

    python sim3d/tools/real_baseline.py --config-set root \
        --legacy-departure-token-distance --out sim3d/tools/out/baseline_before.json

Chạy lại "after" (cùng lệnh, bỏ cờ legacy + đổi ``--out``)::

    python sim3d/tools/real_baseline.py --config-set root \
        --out sim3d/tools/out/baseline_current.json

Bộ config session (đúng chữ của TASK_P16b)::

    python sim3d/tools/real_baseline.py --config-set session \
        --legacy-departure-token-distance \
        --out sim3d/tools/out/baseline_before_sessionconfig.json

Chỉ đọc lại log/preds đã có (không replay)::

    python sim3d/tools/real_baseline.py --config-set root --skip-run \
        --out .../baseline_before.json

Chọn session khác::

    python sim3d/tools/real_baseline.py --session session_hiep1=droidcam_shared_toi1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
REPO_DIR: Final = SIM3D_DIR.parent
MAIN_DETECT_DIR: Final = REPO_DIR / "backend" / "main_detect"
OUTPUT_DIR: Final = MAIN_DETECT_DIR / "experiment_test" / "output"
CONFIG_SESSIONS_DIR: Final = MAIN_DETECT_DIR / "config" / "sessions"
GATE_CONFIG: Final = MAIN_DETECT_DIR / "config" / "gate_zones.json"
DEFAULT_OUT: Final = TOOLS_DIR / "out" / "baseline_before.json"
DEFAULT_WORK_ROOT: Final = TOOLS_DIR / "out" / "p16b"
DEFAULT_MANUAL_COUNTS_PATH: Final = TOOLS_DIR / "out" / "p16b_manual_counts.json"

#: File backend ảnh hưởng trực tiếp số đo. Băm lại trước/sau mỗi replay để phát
#: hiện trường hợp **agent khác sửa backend giữa lúc đo** (đã xảy ra ở P16b: một
#: lần replay chết vì ``cross_camera_manager.py`` đang sửa dở).
CODE_FILES: Final = (
    "runtime_server.py",
    "two_camera.py",
    "src/techgar/cross_camera_manager.py",
    "src/techgar/slot_vehicle_binder.py",
)

#: Nguồn mã để replay. ``head`` = bản đã commit (baseline "trước P16" thật, không
#: bị agent khác sửa giữa lúc đo); ``worktree`` = mã đang có trên đĩa.
CODE_SOURCE_WORKTREE: Final = "worktree"
CODE_SOURCE_HEAD: Final = "head"
CODE_SOURCES: Final[tuple[str, ...]] = (CODE_SOURCE_WORKTREE, CODE_SOURCE_HEAD)

#: Session thật ↔ config era. Chọn theo TASK_P16b: có video + config khớp.
DEFAULT_SESSIONS: Final[dict[str, str]] = {
    "session_hiep2": "droidcam_shared_hiep2",
    "session_hiep_sang7": "droidcam_shared_hiep7",
    "session_hiep_sang8": "droidcam_shared_hiep8",
}

#: File bắt buộc trong thư mục video và trong config session.
VIDEO_FILES: Final = ("raw_cam1.mp4", "raw_cam2.mp4", "frame_timestamps.csv")
CONFIG_FILES: Final = (
    "calibration.json",
    "parking_slots_cam1.json",
    "parking_slots_cam2.json",
    "roi_mask_cam1.json",
    "roi_mask_cam2.json",
)

#: Hai bộ config có thật trong repo:
#:
#: - ``session``: ``config/sessions/droidcam_shared_*`` (bản "recovered", dựng lại
#:   sau khi quay — xem ``MANIFEST.json`` của từng session).
#: - ``root``: bộ config gốc ``config/`` — **chính là bộ đã dùng lúc quay** theo
#:   ``session_info.json`` của video và theo replay chuẩn ``.analysis/verify-replay``
#:   (18/18 session dùng ``config/two_camera.shared_cm_01.json``).
#:
#: Đo thử ``session_hiep2`` cho thấy lựa chọn này đổi hẳn kết quả (7 GID với bộ
#: ``session``, 4 GID khi trộn calibration session + mask root, 2 GID với bộ
#: ``root``) ⇒ phải ghi rõ đang dùng bộ nào.
CONFIG_SET_SESSION: Final = "session"
CONFIG_SET_ROOT: Final = "root"
CONFIG_SETS: Final[tuple[str, ...]] = (CONFIG_SET_SESSION, CONFIG_SET_ROOT)

#: ``root``: tên chuẩn trong ``techgar_config`` → file thật trong ``config/``.
ROOT_CONFIG_SOURCES: Final[dict[str, str]] = {
    "calibration.json": "two_camera.shared_cm_01.json",
    "parking_slots_cam1.json": "parking_slots_cam1.json",
    "parking_slots_cam2.json": "parking_slots_cam2.json",
    "roi_mask_cam1.json": "roi_mask_cam1.json",
    "roi_mask_cam2.json": "roi_mask_cam2.json",
}

#: Nhóm event ``identity_events[].event_type``. Tên event lấy từ
#: ``src/techgar/cross_camera_manager.py`` + ``two_camera.py``.
NEW_GID_EVENTS: Final = frozenset({"global_id_created"})
#: Chỉ event merge **đã hoàn tất** (không tính ``*_deferred``/``*_rejected``/
#: ``*_blocked``). ``cross_camera_duplicate_matched`` là bước ghép cặp, chưa chắc
#: đã merge, nên không cộng vào đây.
MERGE_EVENTS: Final = frozenset(
    {
        "global_id_merged",
        "dormant_duplicate_merged",
        "same_camera_duplicate_merged",
    }
)
#: Re-id/recovery gắn track mới vào GID cũ, **không** gồm handoff (để hai cột
#: không chồng nhau). Handoff khớp được đếm riêng trong ``handoff``.
REID_EVENTS: Final = frozenset(
    {
        "dormant_global_id_recovered",
        "global_id_recovered",
        "dormant_appearance_reentry_recovered",
        "dormant_turnaround_recovered",
        "world_trajectory_reid_matched",
        "world_trajectory_turnaround_matched",
    }
)
HANDOFF_MATCHED_EVENTS: Final = frozenset(
    {"handoff_matched", "handoff_matched_target_gallery"}
)
HANDOFF_REJECTED_EVENTS: Final = frozenset(
    {
        "handoff_rejected",
        "handoff_rejected_recent_identity_ambiguity",
        "handoff_merge_rejected",
        "handoff_dormant_alias_merge_rejected",
    }
)
LOCAL_LOST_EVENTS: Final = frozenset({"local_track_lost", "local_track_expired"})

#: Đếm tay số xe vào/ra (TASK_P16b mục 3). Ghi đè bằng ``--manual-counts``.
#: Cách đếm: xem ``REPORT_P16b.md`` — contact sheet từ raw_cam1/2.mp4, đếm xe
#: thật cắt mép dưới (vào) / mép trên (ra) của mat.
DEFAULT_MANUAL_COUNTS: Final[dict[str, dict[str, Any]]] = {
    "session_hiep2": {
        "vehicles_in": 2,
        "vehicles_out": 2,
        "method": "contact sheet raw_cam1/2 (10 frame/bước) + đối chiếu quỹ đạo world từng GID",
    },
    "session_hiep_sang7": {
        "vehicles_in": 2,
        "vehicles_out": 2,
        "method": "contact sheet raw_cam1/2 (10 frame/bước) + đối chiếu quỹ đạo world từng GID",
    },
    "session_hiep_sang8": {
        "vehicles_in": 2,
        "vehicles_out": 2,
        "method": "contact sheet raw_cam1/2 (10 frame/bước) + đối chiếu quỹ đạo world từng GID",
    },
}


@dataclass(frozen=True)
class SessionSpec:
    """Một session thật + config era tương ứng."""

    name: str
    video_dir: Path
    config_dir: Path

    @property
    def config_name(self) -> str:
        return self.config_dir.name


@dataclass
class SessionResult:
    """Kết quả một session (phần thô trước khi ghi JSON)."""

    spec: SessionSpec
    run_dir: Path
    predictions: Path
    gate_log: Path
    runtime_log: Path
    frames: int = 0
    identity: dict[str, Any] = field(default_factory=dict)
    gate: dict[str, Any] = field(default_factory=dict)
    occupancy: dict[str, Any] = field(default_factory=dict)
    code: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------------------
# Chuẩn bị thư mục chạy
# ---------------------------------------------------------------------------------------
def materialize_root_config(work_root: Path) -> Path:
    """Dựng thư mục config chuẩn hoá từ bộ config **gốc** ``config/``.

    ``config/`` đặt tên calibration là ``two_camera.shared_cm_01.json``; runtime
    lại cần ``calibration.json``. Hàm này copy đúng 5 file cần thiết sang
    ``<work_root>/_configs/root/`` với tên chuẩn để ``prepare_run_dir`` dùng lại
    nguyên logic của bộ ``session``.
    """
    target = work_root / "_configs" / CONFIG_SET_ROOT
    target.mkdir(parents=True, exist_ok=True)
    config_root = MAIN_DETECT_DIR / "config"
    for name, source in ROOT_CONFIG_SOURCES.items():
        src = config_root / source
        if not src.is_file():
            raise FileNotFoundError(f"Không thấy config gốc: {src}")
        shutil.copy2(src, target / name)
    return target


def resolve_session(
    spec_text: str, *, config_set: str = CONFIG_SET_SESSION, work_root: Path | None = None
) -> SessionSpec:
    """``NAME`` hoặc ``NAME=CONFIG`` → :class:`SessionSpec`.

    ``config_set="root"`` bỏ qua ``config/sessions/*`` và dùng bộ config gốc
    ``config/`` (bộ đã dùng lúc quay video) — xem :data:`CONFIG_SETS`.
    """
    if config_set not in CONFIG_SETS:
        raise ValueError(f"config_set phải là một trong {CONFIG_SETS}, nhận {config_set!r}")
    if "=" in spec_text:
        name, config_name = spec_text.split("=", 1)
        name = name.strip()
        config_name = config_name.strip()
    else:
        name = spec_text.strip()
        config_name = DEFAULT_SESSIONS.get(name, "")
        if not config_name:
            raise ValueError(
                f"Không biết config cho session {name!r}. "
                f"Dùng --session {name}=<tên config trong config/sessions>."
            )
    video_dir = (OUTPUT_DIR / name).resolve()
    if config_set == CONFIG_SET_ROOT:
        if work_root is None:
            raise ValueError("config_set='root' cần work_root để dựng thư mục config")
        config_dir = materialize_root_config(work_root).resolve()
    else:
        config_dir = (CONFIG_SESSIONS_DIR / config_name).resolve()
    if not video_dir.is_dir():
        raise FileNotFoundError(f"Không thấy thư mục video: {video_dir}")
    if not config_dir.is_dir():
        raise FileNotFoundError(f"Không thấy config session: {config_dir}")
    missing_video = [f for f in VIDEO_FILES if not (video_dir / f).is_file()]
    if missing_video:
        raise FileNotFoundError(
            f"{video_dir} thiếu {missing_video}; --replay-session cần đủ raw_cam1/2.mp4 "
            "+ frame_timestamps.csv"
        )
    missing_config = [f for f in CONFIG_FILES if not (config_dir / f).is_file()]
    if missing_config:
        raise FileNotFoundError(f"{config_dir} thiếu {missing_config}")
    return SessionSpec(name=name, video_dir=video_dir, config_dir=config_dir)


def code_state(base_dir: Path | None = None) -> dict[str, Any]:
    """Băm các file backend ảnh hưởng số đo + commit HEAD hiện tại.

    Dùng để (a) ghi rõ baseline đo trên mã nào, (b) phát hiện agent khác sửa
    backend **giữa** một replay (hash trước ≠ hash sau).

    ``base_dir`` = thư mục mã đã pin. **Bắt buộc truyền khi replay bằng bản pin**
    (nhất là ``--code-source head``): nếu băm worktree thì JSON sẽ ghi hash của
    mã đang sửa dở trên đĩa, không phải mã thật sự chạy — đúng cái sai đã xảy ra
    ở lần đo "before" đầu tiên (JSON ghi ``711cf16f`` trong khi replay chạy HEAD).
    """
    root = base_dir or MAIN_DETECT_DIR
    files: dict[str, str] = {}
    for relative in CODE_FILES:
        path = root / relative
        if path.is_file():
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        else:
            files[relative] = "missing"
    if base_dir is not None:
        # Bản pin: HEAD/worktree đã chốt lúc pin ⇒ "head" chỉ là nhãn nguồn.
        return {"head": f"pinned:{base_dir.name}", "files": files}
    head = ""
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        head = completed.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        head = "unknown"
    return {"head": head, "files": files}


#: Thư mục không cần pin (môi trường ảo, cache, dữ liệu).
_PIN_SKIP_DIRS: Final = frozenset(
    {".venv", "__pycache__", ".pytest_cache", ".git", "data", "runtime_output_two_camera"}
)


def _code_file_list() -> list[str]:
    """Mọi file ``.py`` cần để dựng lại runtime trong thư mục pin.

    Phải quét **đệ quy cả cây** ``backend/main_detect``: ``two_camera.py`` còn
    ``import tools.rectangle_line_calibration`` (gói ``tools/`` nằm ngoài ``src/``).
    Bản pin đầu tiên chỉ chép ``*.py`` gốc + ``src/**`` nên replay chết ngay:
    ``ModuleNotFoundError: No module named 'tools'``.
    """
    files: list[str] = []
    for path in sorted(MAIN_DETECT_DIR.rglob("*.py")):
        relative = path.relative_to(MAIN_DETECT_DIR)
        if any(part in _PIN_SKIP_DIRS for part in relative.parts):
            continue
        files.append(str(relative).replace("\\", "/"))
    return files


def pin_code(work_root: Path, source: str) -> Path:
    """Chép mã backend ra ``<work_root>/_code/<source>-<hash>/`` để replay.

    Lý do: một agent khác có thể sửa ``backend/`` **giữa** lúc replay (đã xảy ra ở
    P16b: một lần chết vì file đang sửa dở, một lần đổi hành vi giữa session 1 và
    session 2). Pin một bản sao thì số đo luôn thuộc về đúng một trạng thái mã.

    ``source="head"`` lấy bản đã commit bằng ``git show HEAD:<path>`` — đây là
    baseline "trước P16" thật, và bất biến với thay đổi đang làm trên worktree.
    """
    if source not in CODE_SOURCES:
        raise ValueError(f"code_source phải là một trong {CODE_SOURCES}")
    if source == CODE_SOURCE_HEAD:
        # HEAD bất biến theo định nghĩa ⇒ tên thư mục chỉ cần commit.
        fingerprint = code_state()["head"] or "unknown"
    else:
        fingerprint = hashlib.sha256(
            json.dumps(code_state(), sort_keys=True).encode("utf-8")
        ).hexdigest()[:8]
    target = work_root / "_code" / f"{source}-{fingerprint}"
    manifest_path = target / "_pin_manifest.json"
    expected = _code_file_list()
    if (target / "runtime_server.py").is_file() and manifest_path.is_file():
        try:
            recorded = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            recorded = None
        if recorded == expected:
            return target  # bản pin cũ vẫn đúng danh sách file ⇒ dùng lại
        shutil.rmtree(target, ignore_errors=True)  # pin cũ thiếu file ⇒ dựng lại
    target.mkdir(parents=True, exist_ok=True)
    for relative in expected:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source == CODE_SOURCE_HEAD:
            completed = subprocess.run(
                ["git", "show", f"HEAD:backend/main_detect/{relative}"],
                cwd=REPO_DIR,
                capture_output=True,
            )
            if completed.returncode != 0:
                continue  # file chưa từng được commit — bỏ qua
            destination.write_bytes(completed.stdout)
        else:
            shutil.copy2(MAIN_DETECT_DIR / relative, destination)
    manifest_path.write_text(
        json.dumps(expected, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return target


def _link_or_copy(source: Path, target: Path) -> None:
    """Hardlink (cùng ổ D:) để không copy 30–80 MB video; fallback copy."""
    if target.exists() and target.stat().st_size == source.stat().st_size:
        return
    if target.exists():
        target.unlink()
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def prepare_run_dir(spec: SessionSpec, work_root: Path) -> Path:
    """Dựng ``<work>/<session>/`` đúng layout ``run_dir`` của ``m1_gate_eval``.

    Layout::

        run_dir/
          raw_cam1.mp4 -> hardlink
          raw_cam2.mp4 -> hardlink
          frame_timestamps.csv -> hardlink
          techgar_config/{calibration,parking_slots_*,roi_mask_*,gate_zones}.json
    """
    run_dir = work_root / spec.name
    run_dir.mkdir(parents=True, exist_ok=True)
    for filename in VIDEO_FILES:
        _link_or_copy(spec.video_dir / filename, run_dir / filename)
    config_out = run_dir / "techgar_config"
    config_out.mkdir(parents=True, exist_ok=True)
    for filename in CONFIG_FILES:
        shutil.copy2(spec.config_dir / filename, config_out / filename)
    if not GATE_CONFIG.is_file():
        raise FileNotFoundError(f"Không thấy gate config: {GATE_CONFIG}")
    shutil.copy2(GATE_CONFIG, config_out / "gate_zones.json")
    return run_dir


# ---------------------------------------------------------------------------------------
# Parse predictions.jsonl
# ---------------------------------------------------------------------------------------
def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def summarize_predictions(path: Path) -> dict[str, Any]:
    """Đọc ``predictions.jsonl`` → sự kiện identity + coverage + occupancy thô.

    Trả dict thuần JSON (không set) để ghi thẳng ra file.
    """
    event_counts: Counter[str] = Counter()
    frames = 0
    unique_gids: set[int] = set()
    camera_obs: Counter[str] = Counter()
    camera_frames_with_gid: Counter[str] = Counter()
    #: (camera_id, slot_id) → {frames, occupied_frames, last_occupied, gids}
    slots: dict[tuple[str, str], dict[str, Any]] = {}

    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            frames += 1
            for event in record.get("identity_events") or []:
                if isinstance(event, dict):
                    event_counts[str(event.get("event_type") or "")] += 1

            frame_cameras_with_gid: set[str] = set()
            for observation in record.get("observations") or []:
                if not isinstance(observation, dict):
                    continue
                camera = str(observation.get("camera_id") or "")
                camera_obs[camera] += 1
                gid = _as_int(observation.get("canonical_gid"))
                if gid is not None:
                    unique_gids.add(gid)
                    frame_cameras_with_gid.add(camera)
            for camera in frame_cameras_with_gid:
                camera_frames_with_gid[camera] += 1

            for slot in record.get("slots") or []:
                if not isinstance(slot, dict):
                    continue
                key = (
                    str(slot.get("camera_id") or ""),
                    str(slot.get("slot_id") or ""),
                )
                entry = slots.setdefault(
                    key,
                    {
                        "frames": 0,
                        "occupied_frames": 0,
                        "last_occupied": False,
                        "gids": set(),
                    },
                )
                entry["frames"] += 1
                occupied = bool(slot.get("occupied"))
                entry["occupied_frames"] += int(occupied)
                entry["last_occupied"] = occupied
                gid = _as_int(slot.get("canonical_vehicle_gid"))
                if gid is not None:
                    entry["gids"].add(gid)

    new_gid = sum(event_counts[name] for name in NEW_GID_EVENTS)
    merge = sum(event_counts[name] for name in MERGE_EVENTS)
    re_id = sum(event_counts[name] for name in REID_EVENTS)
    handoff_opened = event_counts.get("handoff_opened", 0)
    handoff_matched = sum(event_counts[name] for name in HANDOFF_MATCHED_EVENTS)
    handoff_rejected = sum(event_counts[name] for name in HANDOFF_REJECTED_EVENTS)
    local_lost = sum(event_counts[name] for name in LOCAL_LOST_EVENTS)

    per_camera: dict[str, dict[str, Any]] = {}
    for camera in sorted(set(camera_obs) | set(camera_frames_with_gid)):
        with_gid = camera_frames_with_gid.get(camera, 0)
        per_camera[camera] = {
            "observations": camera_obs.get(camera, 0),
            "frames_with_gid": with_gid,
            "gid_frame_coverage": round(with_gid / frames, 4) if frames else None,
        }

    slot_rows: list[dict[str, Any]] = []
    for (camera, slot_id), entry in sorted(slots.items()):
        observed = int(entry["frames"])
        occupied_frames = int(entry["occupied_frames"])
        slot_rows.append(
            {
                "camera_id": camera,
                "slot_id": slot_id,
                "frames_observed": observed,
                "occupied_frames": occupied_frames,
                "occupied_ratio": round(occupied_frames / observed, 4) if observed else None,
                "final_occupied": bool(entry["last_occupied"]),
                "canonical_gids": sorted(int(g) for g in entry["gids"]),
            }
        )
    ratios = [row["occupied_ratio"] for row in slot_rows if row["occupied_ratio"] is not None]
    occupancy = {
        "ground_truth_available": False,
        "ground_truth_note": (
            "ground_truth_slots.csv của mọi session chỉ có header (0 dòng dữ liệu) — "
            "không so được với GT; các số dưới đây là occupancy runtime đo theo frame, "
            "dùng làm mốc before/after."
        ),
        "slot_count": len(slot_rows),
        "mean_occupied_ratio": round(sum(ratios) / len(ratios), 4) if ratios else None,
        "occupied_slots_final": sum(1 for row in slot_rows if row["final_occupied"]),
        "slots": slot_rows,
    }

    return {
        "frames": frames,
        "new_gid": new_gid,
        "merge": merge,
        "re_id": re_id,
        "handoff": {
            "opened": handoff_opened,
            "matched": handoff_matched,
            "rejected": handoff_rejected,
        },
        "local_track_lost": local_lost,
        "unique_gids": sorted(unique_gids),
        "unique_gid_count": len(unique_gids),
        "event_counts": dict(sorted(event_counts.items())),
        "per_camera": per_camera,
        "occupancy": occupancy,
    }


# ---------------------------------------------------------------------------------------
# Chạy replay + controller
# ---------------------------------------------------------------------------------------
def _load_gate_helpers():
    """Import ``m1_gate_eval`` cùng thư mục (không copy code đã sửa lỗi mất log)."""
    if str(TOOLS_DIR) not in sys.path:
        sys.path.insert(0, str(TOOLS_DIR))
    import m1_gate_eval  # noqa: PLC0415 - cần sys.path trước

    return m1_gate_eval


def run_gate_measurement(
    run_dir: Path,
    *,
    api_port: int,
    gate_port: int,
    poll_interval: float,
    timeout_s: float,
    skip_run: bool,
    extra_runtime_args: tuple[str, ...] = (),
    pinned_code: Path | None = None,
):
    """Chạy (hoặc đọc lại) runtime + ``gate_session_controller`` qua m1_gate_eval.

    ``extra_runtime_args`` được nối vào cuối lệnh runtime (ví dụ
    ``--legacy-departure-token-distance``). Luôn bảo đảm có
    ``--no-session-video`` (quy định tiết kiệm đĩa của director: replay lặp lại
    không ghi video; chỉ lần nghiệm thu cuối mới ghi). ``pinned_code`` thay
    ``runtime_server.py`` bằng bản sao đã pin. Monkeypatch tạm thời
    ``m1_gate_eval._runtime_command`` trong đúng lời gọi này để vẫn dùng runner
    đã sửa lỗi mất log (``-u`` + ``PYTHONUNBUFFERED``) thay vì copy lại.
    """
    gate = _load_gate_helpers()
    if skip_run:
        return gate.load_measurement(run_dir)
    original = gate._runtime_command  # noqa: SLF001 - runner của chính repo

    def _runtime_command(run_dir: Path, *, api_port: int, work: Path) -> list[str]:
        command = original(run_dir, api_port=api_port, work=work)
        if pinned_code is not None:
            # sys.path[0] của script = thư mục chứa nó, nên ``import two_camera``
            # và ``src/techgar`` lấy đúng bản pin; cwd vẫn là MAIN_DETECT_DIR nên
            # đường dẫn tương đối ``config/two_camera.detector.json`` vẫn đúng.
            command[1] = str(pinned_code / "runtime_server.py")
        if "--no-session-video" not in command:
            command.append("--no-session-video")
        return command + list(extra_runtime_args)

    gate._runtime_command = _runtime_command  # type: ignore[assignment]
    try:
        return gate.run_and_measure(
            run_dir,
            api_port=api_port,
            gate_port=gate_port,
            poll_interval=poll_interval,
            timeout_s=timeout_s,
        )
    finally:
        gate._runtime_command = original  # type: ignore[assignment]


def ensure_free_space(work_root: Path, min_free_gb: float) -> None:
    """Dừng trước khi chạy nếu ổ chứa ``work_root`` còn dưới ``min_free_gb``.

    Quy định của director (P16b): kiểm dung lượng trước mỗi lần chạy, dưới 2 GB
    thì dừng và báo lead — không để một replay làm đầy ổ của cả nhóm.
    """
    usage = shutil.disk_usage(work_root)
    free_gb = usage.free / (1024**3)
    if free_gb < min_free_gb:
        raise RuntimeError(
            f"Chỉ còn {free_gb:.2f} GB trống trên ổ của {work_root} "
            f"(ngưỡng {min_free_gb:.2f} GB). Dừng theo quy định tiết kiệm đĩa — "
            "báo lead trước khi chạy tiếp."
        )


def _manual_counts_for(session: str, overrides: dict[str, Any]) -> dict[str, Any] | None:
    if session in overrides:
        value = overrides[session]
        if isinstance(value, dict):
            return {
                "vehicles_in": value.get("vehicles_in"),
                "vehicles_out": value.get("vehicles_out"),
                "method": value.get("method"),
            }
    if session in DEFAULT_MANUAL_COUNTS:
        return dict(DEFAULT_MANUAL_COUNTS[session])
    return None


def measure_session(
    spec: SessionSpec,
    *,
    work_root: Path,
    api_port: int,
    gate_port: int,
    poll_interval: float,
    timeout_s: float,
    skip_run: bool,
    manual_counts: dict[str, Any],
    extra_runtime_args: tuple[str, ...] = (),
    min_free_gb: float = 2.0,
    pinned_code: Path | None = None,
) -> SessionResult:
    """Chạy/đọc lại một session rồi gom số đo."""
    ensure_free_space(work_root, min_free_gb)
    run_dir = prepare_run_dir(spec, work_root)
    state_before = code_state(pinned_code)
    measurement = run_gate_measurement(
        run_dir,
        api_port=api_port,
        gate_port=gate_port,
        poll_interval=poll_interval,
        timeout_s=timeout_s,
        skip_run=skip_run,
        extra_runtime_args=extra_runtime_args,
        pinned_code=pinned_code,
    )
    state_after = code_state(pinned_code)

    work = run_dir / "m1_gate"
    predictions = work / "session" / "predictions.jsonl"
    gate_log = work / "gate_log.txt"
    runtime_log = work / "runtime_log.txt"
    if not predictions.is_file():
        raise FileNotFoundError(
            f"Không thấy {predictions}. Replay chưa ghi predictions.jsonl — xem {runtime_log}"
        )

    summary = summarize_predictions(predictions)
    occupancy = summary.pop("occupancy")
    entries = [
        {
            "global_id": event.global_id,
            "session_id": event.session_id,
            "frame": event.frame,
            "slot": measurement.gid_to_slot.get(event.global_id),
            "log_line": event.line,
        }
        for event in measurement.events
        if event.kind == "gate_in"
    ]
    exits = [
        {
            "global_id": event.global_id,
            "session_id": event.session_id,
            "frame": event.frame,
            "slot": measurement.gid_to_slot.get(event.global_id),
            "log_line": event.line,
        }
        for event in measurement.events
        if event.kind == "gate_out"
    ]

    manual = _manual_counts_for(spec.name, manual_counts)
    gate: dict[str, Any] = {
        "controller_entry": len(entries),
        "controller_exit": len(exits),
        "entries": entries,
        "exits": exits,
        "manual": manual,
        "controller_log": measurement.log_tail,
        "gate_config": str(GATE_CONFIG),
        "gate_config_note": (
            "Không có gate_zones.json theo session trong repo; dùng "
            "backend/main_detect/config/gate_zones.json (map live, cm). "
            "Đây là giả định, không phải config theo era."
        ),
    }
    if manual:
        for key, controller_key in (("vehicles_in", "controller_entry"), ("vehicles_out", "controller_exit")):
            expected = manual.get(key)
            gate[f"{key}_delta"] = (
                None if expected is None else int(gate[controller_key]) - int(expected)
            )

    notes: list[str] = list(measurement.notes)
    notes.append(
        f"predictions.jsonl dùng bộ config '{spec.config_name}' "
        f"({spec.config_dir}); gate_zones dùng bản root (xem gate_config_note)."
    )
    if occupancy["ground_truth_available"] is False:
        notes.append("Không có GT occupancy (ground_truth_slots.csv rỗng).")
    if pinned_code is not None:
        notes.append(
            "replay dùng mã đã pin: "
            f"{pinned_code} — số đo thuộc đúng một trạng thái mã, không bị "
            "agent khác sửa backend giữa lúc đo."
        )
    elif state_before != state_after:
        notes.append(
            "CẢNH BÁO: file backend đổi giữa lúc replay (hash trước ≠ hash sau) — "
            "số đo có thể trộn hai trạng thái mã. Chạy lại khi backend ổn định."
        )

    return SessionResult(
        spec=spec,
        run_dir=run_dir,
        predictions=predictions,
        gate_log=gate_log,
        runtime_log=runtime_log,
        frames=summary["frames"],
        identity=summary,
        gate=gate,
        occupancy=occupancy,
        code={"before": state_before, "after": state_after},
        notes=notes,
    )


# ---------------------------------------------------------------------------------------
# Ghi JSON
# ---------------------------------------------------------------------------------------
def build_document(
    results: list[SessionResult],
    *,
    api_port: int,
    gate_port: int,
    poll_interval: float,
    skip_run: bool,
    extra_runtime_args: tuple[str, ...] = (),
    config_set: str = CONFIG_SET_SESSION,
    tag: str = "",
    code_source: str = CODE_SOURCE_WORKTREE,
    pinned_code: str | None = None,
) -> dict[str, Any]:
    """Gom kết quả nhiều session thành một document JSON so sánh được."""
    totals = {
        "sessions": len(results),
        "frames": sum(result.frames for result in results),
        "new_gid": sum(result.identity["new_gid"] for result in results),
        "merge": sum(result.identity["merge"] for result in results),
        "re_id": sum(result.identity["re_id"] for result in results),
        "handoff_opened": sum(result.identity["handoff"]["opened"] for result in results),
        "handoff_matched": sum(result.identity["handoff"]["matched"] for result in results),
        "local_track_lost": sum(
            result.identity["local_track_lost"] for result in results
        ),
        "controller_entry": sum(result.gate["controller_entry"] for result in results),
        "controller_exit": sum(result.gate["controller_exit"] for result in results),
        "manual_vehicles_in": sum(
            int(result.gate["manual"]["vehicles_in"])
            for result in results
            if result.gate.get("manual")
            and result.gate["manual"].get("vehicles_in") is not None
        ),
        "manual_vehicles_out": sum(
            int(result.gate["manual"]["vehicles_out"])
            for result in results
            if result.gate.get("manual")
            and result.gate["manual"].get("vehicles_out") is not None
        ),
    }
    sessions = []
    for result in results:
        sessions.append(
            {
                "session": result.spec.name,
                "config": result.spec.config_name,
                "video_dir": str(result.spec.video_dir),
                "config_dir": str(result.spec.config_dir),
                "run_dir": str(result.run_dir),
                "frames": result.frames,
                "identity": result.identity,
                "gate": result.gate,
                "occupancy": result.occupancy,
                "logs": {
                    "runtime_log": str(result.runtime_log),
                    "gate_log": str(result.gate_log),
                    "predictions": str(result.predictions),
                },
                "code_state": result.code,
                "notes": result.notes,
            }
        )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(
            timespec="seconds"
        ),
        "tool": "sim3d/tools/real_baseline.py",
        "phase": "P16b",
        "method": {
            "replay": "--replay-session + --live-mode --replay-realtime (runtime_server.py)",
            "controller": "backend/gate_session_controller.py --runtime-url --gate-config --port",
            "controller_counts_source": "stdout [ENTRY]/[EXIT] (m1_gate_eval.parse_controller_log)",
            "identity_source": "predictions.jsonl identity_events (schema v3)",
            "occupancy_source": "predictions.jsonl slots (runtime, không có GT)",
            "api_port_base": api_port,
            "gate_port_base": gate_port,
            "poll_interval_s": poll_interval,
            "skip_run": skip_run,
            "config_set": config_set,
            "tag": tag,
            "code_source": code_source,
            "pinned_code": pinned_code,
            "extra_runtime_args": list(extra_runtime_args),
        },
        "metric_definitions": {
            "new_gid": "sum(identity_events.event_type in %s)" % sorted(NEW_GID_EVENTS),
            "merge": "sum(event_type in %s)" % sorted(MERGE_EVENTS),
            "re_id": "sum(event_type in %s)" % sorted(REID_EVENTS),
            "handoff.opened": "count(handoff_opened)",
            "handoff.matched": "sum(event_type in %s)" % sorted(HANDOFF_MATCHED_EVENTS),
            "handoff.rejected": "sum(event_type in %s)" % sorted(HANDOFF_REJECTED_EVENTS),
            "local_track_lost": "sum(event_type in %s)" % sorted(LOCAL_LOST_EVENTS),
            "occupancy": (
                "tỉ lệ frame occupied theo (camera_id, slot_id) từ predictions.jsonl slots; "
                "GT rỗng nên chỉ dùng so before/after"
            ),
        },
        "totals": totals,
        "sessions": sessions,
    }


def render_markdown(document: dict[str, Any]) -> str:
    """Dựng bảng markdown từ document JSON (để dán thẳng vào REPORT)."""
    lines = [
        "| session | frame | new GID | merge | re-id | handoff (mở/khớp) | lost | "
        "ENTRY | EXIT | đếm tay (vào/ra) | coverage cam1 / cam2 | mã ổn định |",
        "|---" * 12 + "|",
    ]
    for session in document["sessions"]:
        identity = session["identity"]
        gate = session["gate"]
        manual = gate.get("manual") or {}
        coverage = " / ".join(
            f"{camera['gid_frame_coverage']:.2f}"
            for camera in identity["per_camera"].values()
        )
        stable = session["code_state"]["before"] == session["code_state"]["after"]
        if str(session["code_state"]["before"].get("head", "")).startswith("pinned:"):
            stable_text = "pin"
        else:
            stable_text = "có" if stable else "KHÔNG"
        lines.append(
            f"| `{session['session']}` | {session['frames']} | {identity['new_gid']} | "
            f"{identity['merge']} | {identity['re_id']} | "
            f"{identity['handoff']['opened']}/{identity['handoff']['matched']} | "
            f"{identity['local_track_lost']} | {gate['controller_entry']} | "
            f"{gate['controller_exit']} | "
            f"{manual.get('vehicles_in', '?')}/{manual.get('vehicles_out', '?')} | "
            f"{coverage} | {stable_text} |"
        )
    totals = document["totals"]
    lines.append(
        f"| **TOTAL** | {totals['frames']} | {totals['new_gid']} | {totals['merge']} | "
        f"{totals['re_id']} | {totals['handoff_opened']}/{totals['handoff_matched']} | "
        f"{totals['local_track_lost']} | {totals['controller_entry']} | "
        f"{totals['controller_exit']} | "
        f"{totals['manual_vehicles_in']}/{totals['manual_vehicles_out']} | — | — |"
    )
    method = document["method"]
    lines += [
        "",
        f"- mã: `{method['code_source']}` (pin: `{method['pinned_code']}`)",
        f"- config: `{method['config_set']}`; tag: `{method['tag']}`; "
        f"cờ phụ: {method['extra_runtime_args'] or 'không'}",
        f"- tạo lúc: {document['generated_at']}",
    ]
    return "\n".join(lines)


def print_summary(document: dict[str, Any]) -> None:
    """In bảng ngắn cho người chạy."""
    print("\nP16b real baseline")
    print(
        f"  {'session':24}{'frames':>7}{'new':>5}{'merge':>6}{'re-id':>6}"
        f"{'handoff':>8}{'lost':>6}{'ENTRY':>7}{'EXIT':>6}{'manual':>9}"
    )
    for session in document["sessions"]:
        identity = session["identity"]
        gate = session["gate"]
        manual = gate.get("manual") or {}
        manual_text = (
            f"{manual.get('vehicles_in')}/{manual.get('vehicles_out')}"
            if manual
            else "?"
        )
        print(
            f"  {session['session']:24}{session['frames']:>7}"
            f"{identity['new_gid']:>5}{identity['merge']:>6}{identity['re_id']:>6}"
            f"{identity['handoff']['opened']:>8}{identity['local_track_lost']:>6}"
            f"{gate['controller_entry']:>7}{gate['controller_exit']:>6}"
            f"{manual_text:>9}"
        )
    totals = document["totals"]
    manual_total = (
        f"{totals['manual_vehicles_in']}/{totals['manual_vehicles_out']}"
    )
    print(
        f"  {'TOTAL':24}{totals['frames']:>7}{totals['new_gid']:>5}"
        f"{totals['merge']:>6}{totals['re_id']:>6}{totals['handoff_opened']:>8}"
        f"{totals['local_track_lost']:>6}{totals['controller_entry']:>7}"
        f"{totals['controller_exit']:>6}{manual_total:>9}"
    )


# ---------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------
def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="P16b — baseline video thật: replay + controller + identity events"
    )
    result.add_argument(
        "--session",
        action="append",
        default=None,
        help=(
            "session thật, dạng NAME hoặc NAME=CONFIG (mặc định: 3 session trong "
            f"{sorted(DEFAULT_SESSIONS)})"
        ),
    )
    result.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"file JSON kết quả (mặc định {DEFAULT_OUT})",
    )
    result.add_argument(
        "--markdown",
        type=Path,
        default=None,
        help="ghi thêm bảng markdown của kết quả ra file này (dán thẳng vào REPORT)",
    )
    result.add_argument(
        "--work-root",
        type=Path,
        default=DEFAULT_WORK_ROOT,
        help=f"thư mục làm việc (mặc định {DEFAULT_WORK_ROOT})",
    )
    result.add_argument(
        "--tag",
        default="",
        help=(
            "hậu tố thư mục chạy, để hai lần đo (before/after) không ghi đè "
            "m1_gate/ của nhau. Ví dụ --tag current -> out/p16b_root_current"
        ),
    )
    result.add_argument(
        "--manual-counts",
        type=Path,
        default=DEFAULT_MANUAL_COUNTS_PATH,
        help=f"JSON đếm tay (mặc định {DEFAULT_MANUAL_COUNTS_PATH} nếu có)",
    )
    result.add_argument("--api-port", type=int, default=8031, help="cổng API runtime (>=8031)")
    result.add_argument("--gate-port", type=int, default=8030, help="cổng controller (>=8030)")
    result.add_argument("--poll-interval", type=float, default=0.2)
    result.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="giây tối đa mỗi replay (mặc định: frames/3 + 240, tối thiểu 300)",
    )
    result.add_argument(
        "--code-source",
        choices=CODE_SOURCES,
        default=CODE_SOURCE_WORKTREE,
        help=(
            "mã backend dùng để replay: 'worktree' = mã đang có trên đĩa; "
            "'head' = bản đã commit (baseline trước P16, không bị sửa giữa lúc đo)"
        ),
    )
    result.add_argument(
        "--no-pin-code",
        action="store_true",
        help=(
            "tắt pin mã (mặc định pin: chép backend ra <work-root>/_code/ để "
            "agent khác sửa backend không làm hỏng số đo)"
        ),
    )
    result.add_argument(
        "--min-free-gb",
        type=float,
        default=2.0,
        help=(
            "dừng nếu ổ chứa --work-root còn dưới ngưỡng này (GB). "
            "Quy định director: <2 GB thì dừng, báo lead"
        ),
    )
    result.add_argument(
        "--skip-run",
        action="store_true",
        help="không replay; đọc lại <run_dir>/m1_gate/ có sẵn",
    )
    result.add_argument(
        "--runtime-arg",
        action="append",
        default=[],
        help=(
            "cờ phụ truyền thẳng cho runtime_server.py (lặp được), ví dụ "
            "--runtime-arg --legacy-departure-token-distance"
        ),
    )
    result.add_argument(
        "--config-set",
        choices=CONFIG_SETS,
        default=CONFIG_SET_SESSION,
        help=(
            "bộ config dùng để replay: 'session' = config/sessions/droidcam_shared_* "
            "(bản recovered); 'root' = bộ config gốc config/ (bộ đã dùng lúc quay, "
            "theo session_info.json và replay chuẩn verify-replay)"
        ),
    )
    result.add_argument(
        "--legacy-departure-token-distance",
        action="store_true",
        help=(
            "chạy runtime với --legacy-departure-token-distance (hành vi trước P16c; "
            "dùng để đo baseline 'before' khi worktree đã có fix P16c)"
        ),
    )
    return result


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parser().parse_args(argv)

    work_root = args.work_root.resolve()
    if args.config_set != CONFIG_SET_SESSION:
        # Không trộn thư mục chạy của hai bộ config.
        work_root = work_root.with_name(f"{work_root.name}_{args.config_set}")
    if args.tag:
        work_root = work_root.with_name(f"{work_root.name}_{args.tag}")
    work_root.mkdir(parents=True, exist_ok=True)
    specs = [
        resolve_session(text, config_set=args.config_set, work_root=work_root)
        for text in (args.session or DEFAULT_SESSIONS)
    ]
    extra_runtime_args = list(args.runtime_arg)
    if args.legacy_departure_token_distance:
        extra_runtime_args.append("--legacy-departure-token-distance")

    pinned_code: Path | None = None
    if not args.no_pin_code:
        pinned_code = pin_code(work_root, args.code_source)
        print(f"  mã pin: {pinned_code} (nguồn: {args.code_source})")

    manual_overrides: dict[str, Any] = {}
    if args.manual_counts and args.manual_counts.is_file():
        manual_overrides = json.loads(
            args.manual_counts.read_text(encoding="utf-8")
        )
        if not isinstance(manual_overrides, dict):
            raise ValueError(f"{args.manual_counts} phải là JSON object")

    results: list[SessionResult] = []
    for index, spec in enumerate(specs):
        api_port = args.api_port + 2 * index
        gate_port = args.gate_port + 2 * index
        frames_hint = 0
        try:
            with (spec.video_dir / "frame_timestamps.csv").open(
                encoding="utf-8-sig"
            ) as handle:
                frames_hint = max(0, sum(1 for _ in handle) - 1)
        except OSError:
            pass
        timeout_s = (
            args.timeout
            if args.timeout is not None
            else max(300.0, frames_hint / 3.0 + 240.0)
        )
        print(
            f"\n[{index + 1}/{len(specs)}] {spec.name} "
            f"(config {spec.config_name}, {frames_hint} frames, "
            f"api {api_port}, gate {gate_port})"
        )
        result = measure_session(
            spec,
            work_root=work_root,
            api_port=api_port,
            gate_port=gate_port,
            poll_interval=args.poll_interval,
            timeout_s=timeout_s,
            skip_run=args.skip_run,
            manual_counts=manual_overrides,
            extra_runtime_args=tuple(extra_runtime_args),
            min_free_gb=args.min_free_gb,
            pinned_code=pinned_code,
        )
        results.append(result)
        identity = result.identity
        print(
            f"  new_gid={identity['new_gid']} merge={identity['merge']} "
            f"re_id={identity['re_id']} handoff={identity['handoff']['opened']} "
            f"lost={identity['local_track_lost']} "
            f"ENTRY={result.gate['controller_entry']} EXIT={result.gate['controller_exit']}"
        )

    document = build_document(
        results,
        api_port=args.api_port,
        gate_port=args.gate_port,
        poll_interval=args.poll_interval,
        skip_run=args.skip_run,
        extra_runtime_args=tuple(extra_runtime_args),
        config_set=args.config_set,
        tag=args.tag,
        code_source=args.code_source,
        pinned_code=str(pinned_code) if pinned_code else None,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print_summary(document)
    print(f"\nĐã ghi: {args.out.resolve()}")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(render_markdown(document) + "\n", encoding="utf-8")
        print(f"Đã ghi bảng markdown: {args.markdown.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

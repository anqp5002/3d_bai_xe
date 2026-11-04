"""Đếm cổng M1 động (P10c phần A): so số lượt vào/ra của ``gate_session_controller`` với GT.

Chạy::

    python sim3d/tools/m1_gate_eval.py <RUN_DIR>              # replay + controller + đếm
    python sim3d/tools/m1_gate_eval.py <RUN_DIR> --skip-run    # chỉ đánh giá lại từ log có sẵn

Ghi **chỉ trong** ``<RUN_DIR>/m1_gate/``:

- ``runtime_log.txt``   stdout/stderr của ``runtime_server.py``
- ``gate_log.txt``      stdout/stderr của ``gate_session_controller.py``
- ``gate_poll.jsonl``   bằng chứng polling: mỗi dòng ``{t, frame, sessions[]}``
- ``gate_result.json``  số đếm GT vs controller + kết luận đạt/không
- ``gate_mismatches.csv`` từng ca lệch (chỉ sinh khi số đếm lệch)

Vì sao phải chạy **hai** tiến trình
-----------------------------------
``gate_session_controller.py`` chỉ đếm khi snapshot có ``source_mode == "live"``
(``_fresh_live``, dòng 103–104). Runtime khi replay mặc định phát ``source_mode="replay"``
(``two_camera.py:2864``), nên **bắt buộc** ``runtime_server.py --live-mode``.

``--live-mode`` là cờ của **runtime**, không phải của controller: ``parser()`` của
``gate_session_controller.py`` (dòng 855–868) chỉ có ``--source``, ``--runtime-url``,
``--gate-config``, ``--port``, ``--poll-interval``, ``--parked-confirm-seconds``.
Truyền ``--live-mode`` cho controller sẽ bị argparse từ chối. (ANS_7 và README `techgar_config`
ghi ``gate_session_controller.py --live-mode`` — đó là chỗ sai; script này dùng cờ đúng.)

Nguồn số đếm
------------
Controller in ra stdout đúng một dòng cho mỗi lượt:

- ``[ENTRY] Global ID #<gid> -> session <sid>``   (gate_session_controller.py:521)
- ``[EXIT] Global ID #<gid> -> deleted session <sid>`` (dòng 534)

Đó là số **controller thật sự đếm**. Ngoài ra script tự poll ``GET /api/sessions`` của
controller (dòng 784) để gán **frame** cho từng lượt: session xuất hiện ⇒ frame vào,
session biến mất ⇒ frame ra. Log không có frame, API không có frame, nên phải ghép hai nguồn;
frame gán theo mốc polling (``--poll-interval``), **không** phải frame chính xác tuyệt đối.

Điều kiện đạt (ANS_7): số lượt vào và số lượt ra khớp GT **±0**.

Dọn dẹp
-------
``backend/data/navigation_sessions.json`` là store thật của TechGAR. Script đặt
``TECHGAR_SESSIONS_FILE`` (``session_manager.py:23-27``) trỏ vào ``<RUN_DIR>/m1_gate/gate/``
để **không** làm bẩn store của backend. Không sửa file nào của backend.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
REPO_DIR: Final = SIM3D_DIR.parent
VENV_PYTHON: Final = REPO_DIR / "backend" / "main_detect" / ".venv" / "Scripts" / "python.exe"
MAIN_DETECT_DIR: Final = REPO_DIR / "backend" / "main_detect"
CONTROLLER_SCRIPT: Final = REPO_DIR / "backend" / "gate_session_controller.py"

#: Cổng mặc định đúng như ANS_7 / README techgar_config. ``--api-port`` của ``m1_eval.py``
#: là 8011, nên nếu coders-2 chạy song song thì đổi cổng bằng cờ.
DEFAULT_API_PORT: Final = 8001
DEFAULT_GATE_PORT: Final = 8000

#: Nhịp poll controller API. Controller tự poll runtime mỗi 0,25 s
#: (``--poll-interval`` dòng 865), nên 0,2 s là đủ mịn mà không spam.
DEFAULT_POLL_INTERVAL: Final = 0.2

#: Hai dòng controller in ra khi đếm (xem docstring).
ENTRY_PATTERN: Final = re.compile(r"\[ENTRY\] Global ID #(?P<gid>\d+) -> session (?P<sid>\S+)")
EXIT_PATTERN: Final = re.compile(
    r"\[EXIT\] Global ID #(?P<gid>\d+) -> deleted session (?P<sid>\S+)"
)

TEMPLATE_FPS: Final = 25.0


# ---------------------------------------------------------------------------------------
# Dữ liệu
# ---------------------------------------------------------------------------------------
@dataclass(frozen=True)
class GtGateCase:
    """Một dòng ``gt_events.csv`` có ít nhất một mốc qua cổng."""

    car: str
    slot: str
    gate_in_frame: int | None
    gate_out_frame: int | None
    initial_parked: int


@dataclass(frozen=True)
class ControllerEvent:
    """Một lượt vào/ra **controller đã đếm** (một dòng stdout)."""

    kind: str  # "gate_in" | "gate_out"
    global_id: int
    session_id: str
    line: int
    frame: int | None = None


@dataclass
class GateMeasurement:
    """Kết quả đo một run."""

    gt_cases: list[GtGateCase] = field(default_factory=list)
    events: list[ControllerEvent] = field(default_factory=list)
    #: ``global_id -> slot`` suy từ ``parkedSpotId`` của session (khi có).
    gid_to_slot: dict[int, str] = field(default_factory=dict)
    #: Phân loại lỗi cuối ``gate_log.txt`` (``describe_log_tail``).
    log_tail: dict[str, object] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def _maybe_int(value: str | None) -> int | None:
    """Chuỗi rỗng/None → None; ngược lại → int (ném ``ValueError`` nếu rác)."""
    if value is None:
        return None
    text = value.strip()
    if text == "":
        return None
    return int(text)


def read_gt_gate_cases(path: Path) -> list[GtGateCase]:
    """Đọc ``gt_events.csv``, giữ mọi dòng có ``gate_in_frame`` hoặc ``gate_out_frame``."""
    if not path.exists():
        raise FileNotFoundError(f"Không thấy {path}")
    cases: list[GtGateCase] = []
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            gate_in = _maybe_int(row.get("gate_in_frame"))
            gate_out = _maybe_int(row.get("gate_out_frame"))
            if gate_in is None and gate_out is None:
                continue
            cases.append(
                GtGateCase(
                    car=str(row.get("car") or ""),
                    slot=str(row.get("slot") or ""),
                    gate_in_frame=gate_in,
                    gate_out_frame=gate_out,
                    initial_parked=int(row.get("initial_parked") or 0),
                )
            )
    return cases


def count_gt(cases: list[GtGateCase]) -> tuple[int, int]:
    """Trả ``(số lượt vào, số lượt ra)`` theo GT."""
    return (
        sum(1 for case in cases if case.gate_in_frame is not None),
        sum(1 for case in cases if case.gate_out_frame is not None),
    )


#: Runtime đóng cổng HTTP ngay khi replay xong (``runtime_server.py`` khối ``finally``),
#: nên lần poll kế tiếp của controller có thể ném lỗi kết nối. Đây là **dọn dẹp sau khi
#: replay đã xong**, không phải lỗi đếm — nhưng vẫn phải ghi ra, không im lặng (R2).
def describe_log_tail(text: str) -> dict[str, object]:
    """Phân loại lỗi ở cuối ``gate_log.txt`` (nếu có).

    Trả ``{has_traceback, connection_errors, source_unavailable, kind}`` để
    ``gate_result.json`` nói rõ vì sao log có traceback, thay vì để người đọc tự đoán là
    lỗi đếm. ``kind`` là:

    - ``"none"``         — log sạch.
    - ``"teardown"``     — chỉ có lỗi kết nối, xảy ra sau khi replay đã xong (bình thường:
      runtime đóng cổng trước khi controller kịp poll lần cuối).
    - ``"unexpected"``   — có traceback/lỗi khác: phải xem ``gate_log.txt``.
    """
    lines = text.splitlines()
    has_traceback = any(line.startswith("Traceback (most recent call last)") for line in lines)
    connection_errors = sum(
        1
        for line in lines
        if "ConnectionResetError" in line or "ConnectionAbortedError" in line
    )
    source_unavailable = sum(1 for line in lines if "[GATE] Source unavailable" in line)
    if not has_traceback and source_unavailable == 0:
        kind = "none"
    elif has_traceback and connection_errors > 0:
        kind = "teardown"
    else:
        kind = "unexpected"
    return {
        "has_traceback": has_traceback,
        "connection_errors": connection_errors,
        "source_unavailable": source_unavailable,
        "kind": kind,
    }


def parse_controller_log(text: str) -> list[ControllerEvent]:
    """Lấy mọi dòng ``[ENTRY]``/``[EXIT]`` từ stdout của controller, giữ đúng thứ tự."""
    events: list[ControllerEvent] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        entry = ENTRY_PATTERN.search(line)
        if entry is not None:
            events.append(
                ControllerEvent(
                    kind="gate_in",
                    global_id=int(entry.group("gid")),
                    session_id=entry.group("sid"),
                    line=line_number,
                )
            )
            continue
        exit_match = EXIT_PATTERN.search(line)
        if exit_match is not None:
            events.append(
                ControllerEvent(
                    kind="gate_out",
                    global_id=int(exit_match.group("gid")),
                    session_id=exit_match.group("sid"),
                    line=line_number,
                )
            )
    return events


def attach_frames(
    events: list[ControllerEvent], polls: list[dict[str, Any]]
) -> tuple[list[ControllerEvent], dict[int, str]]:
    """Gán frame cho từng lượt dựa trên chuỗi polling.

    ``polls`` là các dòng ``gate_poll.jsonl``: ``{t, frame, sessions: [{sessionId,
    globalVehicleId, parkedSpotId, state}]}``. Session xuất hiện lần đầu ⇒ frame vào;
    session biến mất (đã bị controller xoá) ⇒ frame ra. Session còn sống khi hết replay ⇒
    frame ra để ``None`` (và ghi chú).
    """
    first_seen: dict[str, int] = {}
    last_seen: dict[str, int] = {}
    gid_to_slot: dict[int, str] = {}
    for poll in polls:
        frame = poll.get("frame")
        if not isinstance(frame, int):
            continue
        for session in poll.get("sessions") or []:
            if not isinstance(session, dict):
                continue
            session_id = str(session.get("sessionId") or "")
            if session_id == "":
                continue
            first_seen.setdefault(session_id, frame)
            last_seen[session_id] = frame
            parked = session.get("parkedSpotId")
            raw_gid = session.get("globalVehicleId")
            if isinstance(parked, str) and parked and raw_gid is not None:
                try:
                    gid_to_slot[int(raw_gid)] = parked
                except (TypeError, ValueError):
                    continue

    final_frame = polls[-1]["frame"] if polls and isinstance(polls[-1].get("frame"), int) else None
    # Session đã biến mất = last_seen < frame cuối của cả chuỗi poll.
    vanished: dict[str, int] = {}
    if final_frame is not None:
        for session_id, frame in last_seen.items():
            if frame < final_frame:
                vanished[session_id] = frame

    resolved: list[ControllerEvent] = []
    for event in events:
        frame: int | None = None
        if event.kind == "gate_in":
            frame = first_seen.get(event.session_id)
        else:
            # Exit: frame cuối cùng còn thấy session trước khi bị xoá.
            frame = vanished.get(event.session_id, last_seen.get(event.session_id))
        resolved.append(
            ControllerEvent(
                kind=event.kind,
                global_id=event.global_id,
                session_id=event.session_id,
                line=event.line,
                frame=frame,
            )
        )
    return resolved, gid_to_slot


#: Cot c?a ``gt_gate_ideal.csv`` (ANS_18 mục 1).
IDEAL_COLUMNS: Final = ("car_id", "frame", "kind", "visible")


@dataclass(frozen=True)
class IdealRow:
    """Một dòng ``gt_gate_ideal.csv``: bộ đếm **lý tưởng** ứng với
    ``backend/gate_session_controller.py:498-534``."""

    car_id: str
    frame: int
    kind: str  # "entry" | "exit"
    visible: int  # 1 = camera thấy điểm cắt


def read_gate_ideal(path: Path) -> list[IdealRow]:
    """Đọc ``gt_gate_ideal.csv``; ném lỗi rõ nếu thiếu file/cột (R2).

    File này **tuỳ chọn** với run cũ (chưa có ANS_18): trả ``[]`` thay vì ném lỗi để
    script vẫn dùng được với run cũ; ``evaluate`` sẽ ghi rõ là "không có GT lý tưởng".
    """
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames or []
        missing = [name for name in IDEAL_COLUMNS if name not in columns]
        if missing:
            raise ValueError(f"{path.name}: thiếu cột {', '.join(missing)}")
        rows: list[IdealRow] = []
        for row in reader:
            kind = (row.get("kind") or "").strip()
            if kind not in {"entry", "exit"}:
                raise ValueError(f"{path.name}: kind={kind!r} không hợp lệ")
            rows.append(
                IdealRow(
                    car_id=str(row.get("car_id") or "").strip(),
                    frame=int((row.get("frame") or "").strip()),
                    kind=kind,
                    visible=int((row.get("visible") or "").strip()),
                )
            )
    return rows


def count_ideal(rows: list[IdealRow]) -> tuple[int, int]:
    """``(số entry, số exit)`` chỉ trên dòng ``visible=1`` (ANS_18 mục 2)."""
    visible = [row for row in rows if row.visible == 1]
    return (
        sum(1 for row in visible if row.kind == "entry"),
        sum(1 for row in visible if row.kind == "exit"),
    )


def build_ideal_mismatches(
    events: list[ControllerEvent], ideal_rows: list[IdealRow]
) -> list[dict[str, object]]:
    """Liệt kê từng ca lệch giữa controller và GT lý tưởng (chỉ dòng ``visible=1``).

    Ghép theo **thứ tự thời gian trong từng loại**, không ghép theo frame gần nhất: bộ đếm
    là máy trạng thái tuần tự, nên lượt thứ *k* của controller ứng với lượt thứ *k* của
    GT. Không cần ``global_id -> car`` (snapshot không có).

    Một cặp chỉ sinh **một** dòng: khớp frame → không lệch; lệch frame → ``lech_frame``;
    thiếu bên GT → ``dem_them``; thiếu bên controller → ``thieu_luot``.
    """
    visible = [row for row in ideal_rows if row.visible == 1]
    out: list[dict[str, object]] = []
    for kind, label in (("entry", "gate_in"), ("exit", "gate_out")):
        expected = [row for row in visible if row.kind == kind]
        got = [event for event in events if event.kind == label]
        for index in range(max(len(expected), len(got))):
            want = expected[index] if index < len(expected) else None
            have = got[index] if index < len(got) else None
            if want is not None and have is not None:
                if have.frame is None:
                    out.append(
                        {
                            "kind": label,
                            "reason": "khong_gan_duoc_frame",
                            "car": want.car_id,
                            "ideal_frame": want.frame,
                            "controller_frame": "",
                            "delta": "",
                        }
                    )
                elif have.frame != want.frame:
                    out.append(
                        {
                            "kind": label,
                            "reason": "lech_frame",
                            "car": want.car_id,
                            "ideal_frame": want.frame,
                            "controller_frame": have.frame,
                            "delta": have.frame - want.frame,
                        }
                    )
                continue
            if want is not None:
                out.append(
                    {
                        "kind": label,
                        "reason": "thieu_luot",
                        "car": want.car_id,
                        "ideal_frame": want.frame,
                        "controller_frame": "",
                        "delta": "",
                    }
                )
            elif have is not None:
                out.append(
                    {
                        "kind": label,
                        "reason": "dem_them",
                        "car": "?",
                        "ideal_frame": "",
                        "controller_frame": "" if have.frame is None else have.frame,
                        "delta": "",
                    }
                )
    return out


def build_mismatches(
    measurement: GateMeasurement,
) -> list[dict[str, object]]:
    """Ghép GT ↔ controller theo **slot** (khi suy được), trả danh sách ca lệch.

    Chỉ gọi khi số đếm lệch. Không suy được ``global_id → slot`` thì vẫn liệt kê ca GT
    thiếu và ca controller thừa với ``car="?"``/``global_id=""``, không im lặng.
    """
    rows: list[dict[str, object]] = []
    for kind, gt_attr in (("gate_in", "gate_in_frame"), ("gate_out", "gate_out_frame")):
        gt_cases = [
            case for case in measurement.gt_cases if getattr(case, gt_attr) is not None
        ]
        controller = [event for event in measurement.events if event.kind == kind]
        # slot -> global_id (một-một theo dữ liệu quan sát được)
        slot_to_gid = {
            slot: gid for gid, slot in measurement.gid_to_slot.items() if slot
        }
        used_gids: set[int] = set()
        for case in gt_cases:
            gid = slot_to_gid.get(case.slot)
            match = next(
                (
                    event
                    for event in controller
                    if gid is not None
                    and event.global_id == gid
                    and event.global_id not in used_gids
                ),
                None,
            )
            if match is not None:
                used_gids.add(match.global_id)
                continue
            rows.append(
                {
                    "kind": kind,
                    "reason": "gt_khong_thay_o_controller",
                    "car": case.car,
                    "slot": case.slot,
                    "gt_frame": getattr(case, gt_attr),
                    "global_id": "" if gid is None else gid,
                    "controller_frame": "",
                }
            )
        for event in controller:
            if event.global_id in used_gids:
                continue
            rows.append(
                {
                    "kind": kind,
                    "reason": "controller_dem_them",
                    "car": "?",
                    "slot": measurement.gid_to_slot.get(event.global_id, "?"),
                    "gt_frame": "",
                    "global_id": event.global_id,
                    "controller_frame": "" if event.frame is None else event.frame,
                }
            )
    return rows


# ---------------------------------------------------------------------------------------
# Chạy
# ---------------------------------------------------------------------------------------
def _http_json(url: str, timeout: float = 3.0) -> Any:
    with urlopen(url, timeout=timeout) as response:  # noqa: S310 - URL do script tự dựng
        return json.loads(response.read().decode("utf-8"))


def _wait_for_runtime(url: str, timeout_s: float) -> dict[str, Any]:
    """Chờ snapshot đầu tiên có ``source_mode == "live"``."""
    deadline = time.monotonic() + timeout_s
    last_error = "chưa gọi lần nào"
    while time.monotonic() < deadline:
        try:
            snapshot = _http_json(url)
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            last_error = f"{type(error).__name__}: {error}"
            time.sleep(0.25)
            continue
        if isinstance(snapshot, dict) and snapshot.get("source_mode") == "live":
            return snapshot
        last_error = f"source_mode={snapshot.get('source_mode') if isinstance(snapshot, dict) else snapshot!r}"
        time.sleep(0.25)
    raise TimeoutError(
        f"runtime không phát snapshot source_mode=live sau {timeout_s:.0f} s ({last_error}). "
        "Thiếu --live-mode? (controller bỏ qua snapshot source_mode=replay)"
    )


def _runtime_extra_args() -> list[str]:
    """Cờ thêm cho runtime từ biến môi trường ``GATE_RUNTIME_EXTRA`` (P18: đo trước/sau bằng
    ``--legacy-*``), ví dụ ``GATE_RUNTIME_EXTRA="--legacy-token-continuation-range"``."""
    return os.environ.get("GATE_RUNTIME_EXTRA", "").split()


def _runtime_command(run_dir: Path, *, api_port: int, work: Path) -> list[str]:
    """Lệnh replay giống REPORT_M1 nhưng thêm ``--live-mode`` và ghi vào ``m1_gate/``."""
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
        str(work / "runtime"),
        "--session-dir",
        str(work / "session"),
        # Không sao chép lại raw/debug MP4: đếm cổng không cần video, run đã có sẵn.
        "--no-session-video",
        # Controller chỉ nhận snapshot source_mode="live" (gate_session_controller.py:104).
        "--live-mode",
        # Nhịp thật để age_ms/published_at còn trong cửa sổ 5 s của _fresh_live.
        "--replay-realtime",
        "--api-port",
        str(api_port),
        "--no-display",
        *_runtime_extra_args(),
    ]


def _child_environment(sessions_file: Path) -> dict[str, str]:
    """Môi trường cho runtime + controller. PYTHONUNBUFFERED: stdout ra file bị block-buffer,
    ``terminate()`` làm mất ``[ENTRY]``/``[EXIT]`` cuối (DIAG_P16 1d)."""
    environment = dict(os.environ)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["TECHGAR_SESSIONS_FILE"] = str(sessions_file)
    return environment


def _controller_command(run_dir: Path, *, gateway_url: str, gate_port: int) -> list[str]:
    """Lệnh controller. **Không** có ``--live-mode`` — cờ đó không tồn tại ở đây."""
    return [
        str(VENV_PYTHON),
        "-u",  # stdout ra file bị block-buffer, terminate() làm mất [ENTRY]/[EXIT] (DIAG_P16 1d)
        str(CONTROLLER_SCRIPT),
        "--runtime-url",
        gateway_url,
        "--gate-config",
        str(run_dir / "techgar_config" / "gate_zones.json"),
        "--port",
        str(gate_port),
    ]


def run_and_measure(
    run_dir: Path,
    *,
    api_port: int,
    gate_port: int,
    poll_interval: float,
    timeout_s: float,
) -> GateMeasurement:
    """Chạy runtime + controller song song, poll API, trả số đo thô."""
    work = run_dir / "m1_gate"
    work.mkdir(parents=True, exist_ok=True)
    if not VENV_PYTHON.exists():
        raise FileNotFoundError(f"Không có python venv backend: {VENV_PYTHON}")
    if not CONTROLLER_SCRIPT.exists():
        raise FileNotFoundError(f"Không thấy controller: {CONTROLLER_SCRIPT}")

    # session-dir phải chưa tồn tại (two_camera.py:2035 ném FileExistsError).
    for generated in (work / "runtime", work / "session", work / "gate"):
        if generated.exists():
            shutil.rmtree(generated)
    work.mkdir(parents=True, exist_ok=True)

    sessions_file = work / "gate" / "sessions.json"
    environment = _child_environment(sessions_file)

    runtime_log = (work / "runtime_log.txt").open("w", encoding="utf-8")
    gate_log = (work / "gate_log.txt").open("w", encoding="utf-8")
    runtime = subprocess.Popen(  # noqa: S603 - lệnh do script tự dựng
        _runtime_command(run_dir, api_port=api_port, work=work),
        cwd=str(MAIN_DETECT_DIR),
        stdout=runtime_log,
        stderr=subprocess.STDOUT,
        text=True,
        env=environment,
    )
    gateway_url = f"http://127.0.0.1:{api_port}/api/runtime/snapshot"
    controller: subprocess.Popen[str] | None = None
    measurement = GateMeasurement()
    polls: list[dict[str, Any]] = []
    try:
        _wait_for_runtime(gateway_url, timeout_s=120.0)
        controller = subprocess.Popen(  # noqa: S603
            _controller_command(run_dir, gateway_url=gateway_url, gate_port=gate_port),
            cwd=str(REPO_DIR / "backend"),
            stdout=gate_log,
            stderr=subprocess.STDOUT,
            text=True,
            env=environment,
        )
        sessions_url = f"http://127.0.0.1:{gate_port}/api/sessions"
        started = time.monotonic()
        last_frame: int | None = None
        while True:
            if runtime.poll() is not None:
                break
            if time.monotonic() - started > timeout_s:
                raise TimeoutError(f"replay chưa xong sau {timeout_s:.0f} s")
            frame: int | None = None
            try:
                status = _http_json(f"http://127.0.0.1:{api_port}/api/runtime/status")
                if isinstance(status, dict) and isinstance(status.get("frame_index"), int):
                    frame = int(status["frame_index"])
            except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
                # `OSError` gồm `ConnectionResetError`/`ConnectionAbortedError` — runtime đóng
                # cổng ngay khi replay xong, nên lần poll cuối có thể gặp. Giữ frame cuối đã
                # đọc được; vòng lặp sẽ thoát ở lần kiểm `runtime.poll()` kế tiếp.
                frame = last_frame
            sessions: list[dict[str, Any]] = []
            try:
                payload = _http_json(sessions_url)
                if isinstance(payload, dict):
                    sessions = [
                        value for value in payload.values() if isinstance(value, dict)
                    ]
            except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
                sessions = []
            if frame is not None:
                last_frame = frame
                polls.append(
                    {
                        "t": round(time.monotonic() - started, 3),
                        "frame": frame,
                        "sessions": [
                            {
                                "sessionId": str(item.get("sessionId") or ""),
                                "globalVehicleId": item.get("globalVehicleId"),
                                "parkedSpotId": item.get("parkedSpotId"),
                                "state": item.get("state"),
                            }
                            for item in sessions
                        ],
                    }
                )
            time.sleep(poll_interval)
        # Runtime xong: cho controller xử lý snapshot cuối rồi mới dừng.
        time.sleep(max(1.0, 4 * poll_interval))
    finally:
        if controller is not None and controller.poll() is None:
            controller.terminate()
            try:
                controller.wait(timeout=10.0)
            except subprocess.TimeoutExpired:
                controller.kill()
        if runtime.poll() is None:
            runtime.terminate()
            try:
                runtime.wait(timeout=10.0)
            except subprocess.TimeoutExpired:
                runtime.kill()
        runtime_log.close()
        gate_log.close()

    poll_path = work / "gate_poll.jsonl"
    with poll_path.open("w", encoding="utf-8") as handle:
        for poll in polls:
            handle.write(json.dumps(poll, ensure_ascii=False) + "\n")

    log_text = (work / "gate_log.txt").read_text(encoding="utf-8", errors="replace")
    events = parse_controller_log(log_text)
    events, gid_to_slot = attach_frames(events, polls)
    measurement.events = events
    measurement.gid_to_slot = gid_to_slot
    measurement.log_tail = describe_log_tail(log_text)
    if not polls:
        measurement.notes.append("không poll được snapshot nào — không gán được frame")
    return measurement


def load_measurement(run_dir: Path) -> GateMeasurement:
    """``--skip-run``: dựng lại số đo từ ``m1_gate/`` có sẵn (log + poll)."""
    work = run_dir / "m1_gate"
    log_path = work / "gate_log.txt"
    poll_path = work / "gate_poll.jsonl"
    if not log_path.exists():
        raise FileNotFoundError(
            f"Không thấy {log_path}. Chạy lại không có --skip-run để sinh log."
        )
    measurement = GateMeasurement()
    polls: list[dict[str, Any]] = []
    if poll_path.exists():
        with poll_path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    polls.append(json.loads(line))
    else:
        measurement.notes.append(f"không thấy {poll_path.name} — frame của từng lượt sẽ trống")
    events = parse_controller_log(log_path.read_text(encoding="utf-8", errors="replace"))
    events, gid_to_slot = attach_frames(events, polls)
    measurement.events = events
    measurement.gid_to_slot = gid_to_slot
    measurement.log_tail = describe_log_tail(
        log_path.read_text(encoding="utf-8", errors="replace")
    )
    return measurement


# ---------------------------------------------------------------------------------------
# Tổng hợp
# ---------------------------------------------------------------------------------------
def evaluate(
    run_dir: Path,
    *,
    skip_run: bool,
    api_port: int,
    gate_port: int,
    poll_interval: float,
    timeout_s: float,
) -> dict[str, Any]:
    """Chạy (hoặc đọc lại) rồi ghi ``gate_result.json`` + ``gate_mismatches.csv``."""
    gt_cases = read_gt_gate_cases(run_dir / "gt_events.csv")
    gt_in, gt_out = count_gt(gt_cases)

    if skip_run:
        measurement = load_measurement(run_dir)
    else:
        measurement = run_and_measure(
            run_dir,
            api_port=api_port,
            gate_port=gate_port,
            poll_interval=poll_interval,
            timeout_s=timeout_s,
        )
    measurement.gt_cases = gt_cases

    # Phân loại lỗi cuối log một lần, dùng chung cho cả hai đường (chạy mới và --skip-run).
    tail_kind = measurement.log_tail.get("kind")
    if tail_kind == "unexpected":
        measurement.notes.append(
            "gate_log.txt có traceback ngoài dự kiến — xem log trước khi tin số đếm"
        )
    elif tail_kind == "teardown":
        measurement.notes.append(
            "gate_log.txt có ConnectionResetError ở cuối: runtime đóng cổng sau khi replay "
            "xong, controller poll lần cuối thì mất kết nối — không ảnh hưởng số đếm"
        )

    controller_in = sum(1 for event in measurement.events if event.kind == "gate_in")
    controller_out = sum(1 for event in measurement.events if event.kind == "gate_out")
    pass_in = controller_in == gt_in
    pass_out = controller_out == gt_out

    # --- ANS_18 mục 2: so với GT "bộ đếm lý tưởng" (chỉ dòng visible=1) ---
    # Hai loại GT trả lời hai câu hỏi khác nhau (README giải thích):
    #   ngữ nghĩa  = xe có thật sự vào/ra bãi không   (gt_events.csv)
    #   lý tưởng = tracker hoàn hảo qua bộ đếm TechGAR sẽ đếm bao nhiêu (gt_gate_ideal.csv)
    ideal_rows = read_gate_ideal(run_dir / "gt_gate_ideal.csv")
    ideal_in, ideal_out = count_ideal(ideal_rows)
    ideal_available = len(ideal_rows) > 0
    ideal_pass_in = controller_in == ideal_in if ideal_available else None
    ideal_pass_out = controller_out == ideal_out if ideal_available else None
    if not ideal_available:
        measurement.notes.append(
            "không có gt_gate_ideal.csv (run xuất trước ANS_18) — chỉ so được GT ngữ nghĩa"
        )
    ideal_mismatches: list[dict[str, object]] = []
    if ideal_available and not (ideal_pass_in and ideal_pass_out):
        ideal_mismatches = build_ideal_mismatches(measurement.events, ideal_rows)

    mismatches = build_mismatches(measurement) if not (pass_in and pass_out) else []
    work = run_dir / "m1_gate"
    work.mkdir(parents=True, exist_ok=True)

    mismatch_path = work / "gate_mismatches.csv"
    with mismatch_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["kind", "reason", "car", "slot", "gt_frame", "global_id", "controller_frame"]
        )
        for row in mismatches:
            writer.writerow(
                [
                    row["kind"],
                    row["reason"],
                    row["car"],
                    row["slot"],
                    row["gt_frame"],
                    row["global_id"],
                    row["controller_frame"],
                ]
            )

    result: dict[str, Any] = {
        "run_id": run_dir.name,
        "run_dir": str(run_dir),
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "method": {
            "runtime_flag": "--live-mode --replay-realtime (runtime_server.py)",
            "controller_flags": "--runtime-url --gate-config --port "
            "(controller KHÔNG có --live-mode)",
            "controller_counts_source": "stdout [ENTRY]/[EXIT]",
            "frame_source": f"poll GET /api/sessions mỗi {poll_interval} s + /api/runtime/status",
            "session_store": "TECHGAR_SESSIONS_FILE → <RUN_DIR>/m1_gate/gate/sessions.json",
            "api_port": api_port,
            "gate_port": gate_port,
            "skip_run": skip_run,
        },
        "gt": {
            "gate_in": gt_in,
            "gate_out": gt_out,
            "events": [
                {
                    "car": case.car,
                    "slot": case.slot,
                    "gate_in_frame": case.gate_in_frame,
                    "gate_out_frame": case.gate_out_frame,
                    "initial_parked": case.initial_parked,
                }
                for case in gt_cases
            ],
        },
        "controller": {
            "gate_in": controller_in,
            "gate_out": controller_out,
            "entries": [
                {
                    "global_id": event.global_id,
                    "session_id": event.session_id,
                    "frame": event.frame,
                    "slot": measurement.gid_to_slot.get(event.global_id),
                    "log_line": event.line,
                }
                for event in measurement.events
                if event.kind == "gate_in"
            ],
            "exits": [
                {
                    "global_id": event.global_id,
                    "session_id": event.session_id,
                    "frame": event.frame,
                    "slot": measurement.gid_to_slot.get(event.global_id),
                    "log_line": event.line,
                }
                for event in measurement.events
                if event.kind == "gate_out"
            ],
        },
        "pass": {
            "gate_in": pass_in,
            "gate_out": pass_out,
            "overall": pass_in and pass_out,
            "threshold": "số lượt khớp GT ±0 (ANS_7)",
        },
        "gate_ideal": {
            "available": ideal_available,
            "source": "gt_gate_ideal.csv (ANS_18: máy trạng thái gate_session_controller.py:498-534)",
            "visible_rows": sum(1 for row in ideal_rows if row.visible == 1),
            "hidden_rows": sum(1 for row in ideal_rows if row.visible != 1),
            "entry": ideal_in,
            "exit": ideal_out,
            "controller_entry": controller_in,
            "controller_exit": controller_out,
            "pass": {
                "entry": ideal_pass_in,
                "exit": ideal_pass_out,
                "overall": None
                if not ideal_available
                else bool(ideal_pass_in and ideal_pass_out),
            },
            "mismatches": ideal_mismatches,
        },
        "mismatch_count": len(mismatches),
        "controller_log": measurement.log_tail,
        "notes": measurement.notes,
    }
    (work / "gate_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def print_summary(result: dict[str, Any]) -> None:
    """In bảng tóm tắt cho người chạy."""
    gt = result["gt"]
    controller = result["controller"]
    verdict = "ĐẠT" if result["pass"]["overall"] else "KHÔNG ĐẠT"
    print(f"\nCổng — run {result['run_id']}  →  {verdict}")
    print(f"  {'':14}{'GT':>6}{'controller':>12}{'lệch':>7}{'':>3}")
    for kind, label in (("gate_in", "vào (gate_in)"), ("gate_out", "ra (gate_out)")):
        gt_value = gt[kind]
        ctrl_value = controller[kind]
        flag = "OK" if gt_value == ctrl_value else "LỆCH"
        print(f"  {label:14}{gt_value:>6}{ctrl_value:>12}{ctrl_value - gt_value:>+7}   {flag}")
    # ANS_18: so với GT lý tưởng (chỉ dòng camera thấy).
    ideal = result.get("gate_ideal") or {}
    if ideal.get("available") is True:
        ideal_verdict = "ĐẠT" if ideal["pass"]["overall"] else "KHÔNG ĐẠT"
        print(
            f"  — GT lý tưởng (visible={ideal['visible_rows']}, ẩn={ideal['hidden_rows']}): "
            f"{ideal_verdict}"
        )
        print(f"  {'':14}{'lý tưởng':>6}{'controller':>12}{'lệch':>7}")
        for kind, label in (("entry", "vào (entry)"), ("exit", "ra (exit)")):
            want = ideal[kind]
            have = ideal[f"controller_{kind}"]
            flag = "OK" if want == have else "LỆCH"
            print(f"  {label:14}{want:>6}{have:>12}{have - want:>+7}   {flag}")
        for row in ideal["mismatches"][:10]:
            print(
                f"    lệch {row['kind']}: {row['reason']} xe={row['car']} "
                f"lý tưởng={row['ideal_frame']} controller={row['controller_frame']}"
            )
        if len(ideal["mismatches"]) > 10:
            print(f"    … và {len(ideal['mismatches']) - 10} ca lệch nữa (gate_result.json)")
    else:
        print("  — không có gt_gate_ideal.csv → chỉ so GT ngữ nghĩa (run xuất trước ANS_18)")

    for key, label in (("entries", "vào"), ("exits", "ra")):
        for event in controller[key]:
            slot = event["slot"] or "?"
            frame = "?" if event["frame"] is None else str(event["frame"])
            print(
                f"  [{label}] global_id={event['global_id']} slot={slot} frame={frame}"
            )
    if result["mismatch_count"]:
        print(f"  Ca lệch: {result['mismatch_count']} → m1_gate/gate_mismatches.csv")
    for note in result["notes"]:
        print(f"  Ghi chú: {note}")
    print(f"  Kết quả: {Path(result['run_dir']) / 'm1_gate' / 'gate_result.json'}")


def _frames_in(run_dir: Path) -> int:
    """Số frame của run (đọc ``gt_frames.csv``) để tính timeout replay."""
    path = run_dir / "gt_frames.csv"
    if not path.exists():
        return 0
    with path.open(encoding="utf-8") as handle:
        return max(0, sum(1 for _ in handle) - 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Đếm cổng M1: runtime --live-mode + gate_session_controller, so với GT"
    )
    parser.add_argument("run_dir", type=Path, help="thư mục run đã xuất")
    parser.add_argument(
        "--skip-run",
        action="store_true",
        help="không chạy lại, chỉ đánh giá từ m1_gate/gate_log.txt + gate_poll.jsonl",
    )
    parser.add_argument("--api-port", type=int, default=DEFAULT_API_PORT)
    parser.add_argument("--gate-port", type=int, default=DEFAULT_GATE_PORT)
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL)
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="giây tối đa cho replay (mặc định: số frame / 25 × 3 + 180)",
    )
    args = parser.parse_args(argv)

    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"Không thấy thư mục run: {run_dir}", file=sys.stderr)
        return 2
    timeout_s = args.timeout
    if timeout_s is None:
        timeout_s = _frames_in(run_dir) / TEMPLATE_FPS * 3.0 + 180.0

    try:
        result = evaluate(
            run_dir,
            skip_run=args.skip_run,
            api_port=args.api_port,
            gate_port=args.gate_port,
            poll_interval=args.poll_interval,
            timeout_s=timeout_s,
        )
    except (FileNotFoundError, TimeoutError, OSError) as error:
        # R2: không im lặng. Ghi lý do thật vào gate_result.json rồi trả mã lỗi.
        work = run_dir / "m1_gate"
        work.mkdir(parents=True, exist_ok=True)
        failure = {
            "run_id": run_dir.name,
            "run_dir": str(run_dir),
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
        }
        (work / "gate_result.json").write_text(
            json.dumps(failure, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"\nKHÔNG ĐO ĐƯỢC CỔNG: {failure['error']}", file=sys.stderr)
        print(f"Lý do đã ghi vào {work / 'gate_result.json'}", file=sys.stderr)
        return 1

    print_summary(result)
    return 0 if result["pass"]["overall"] else 1


if __name__ == "__main__":
    sys.exit(main())

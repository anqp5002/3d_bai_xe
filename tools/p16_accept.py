"""Nghiệm thu P16 bằng **một lệnh** (TASK_P16f): chạy 4 run sim + baseline video thật,
rồi in bảng ĐẠT/KHÔNG ĐẠT cho từng tiêu chí trong ``.orca/sim3d/SPEC_P16.md`` mục 3 và
``.orca/sim3d/ANS_22.md``.

Script này **không** đo lại gì bằng tay: nó gọi đúng các tool đã có và chỉ đọc JSON chúng
ghi ra.

| bước | tool | đọc kết quả |
|---|---|---|
| occupancy + replay ghi ``predictions.jsonl`` | ``m1_eval.py <RUN>`` | ``<RUN>/m1/metrics.json`` |
| track (đứt thật, GID dùng chung, cam GID) | ``m1_track_eval.py <RUN> --json …`` | JSON của chính nó |
| đếm cổng | ``m1_gate_eval.py <RUN>`` | ``<RUN>/m1_gate/gate_result.json`` |
| R4 video thật | ``real_baseline.py --config-set root`` | ``out/baseline_after.json`` so ``baseline_before.json`` |

Chạy::

    sim3d\\server\\.venv\\Scripts\\python.exe sim3d/tools/p16_accept.py
    … --only k2,k4 --skip-real      # chạy nhanh khi đang sửa

Cổng: tối đa **2 run song song**, cặp cổng 8040/8041 và 8050/8051. Cổng 8020–8033 để
coders-1/coders-2 dùng, script này không đụng. Video thật dùng 8060+ (real_baseline tự
cộng 2 theo index session).

Đĩa: trước mỗi lần chạy kiểm dung lượng; dưới 3 GB thì **dừng** và báo rõ, không làm đầy
ổ của cả nhóm.

Ghi ra ``sim3d/tools/out/``:

- ``p16_accept.json``  toàn bộ số đo + kết luận từng dòng;
- ``p16_accept.md``    bảng dán thẳng vào REPORT;
- ``p16_accept/<run>__<tool>.log``  log từng lần gọi tool (bằng chứng khi số lạ).

"Trước sửa" lấy từ kết quả **đã lưu** trong ``<RUN>/m1/metrics.json`` và
``<RUN>/m1_gate/gate_result.json`` đọc **trước khi** chạy lại (đó là số của P15a, đo trên
mã cũ). Không có file thì ghi "không đo" chứ không bịa số.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
REPO_DIR: Final = SIM3D_DIR.parent
RUNS_DIR: Final = SIM3D_DIR / "data" / "runs"
OUT_DIR: Final = TOOLS_DIR / "out"
OUTPUT_SUBDIR: Final = "p16_accept"

#: Run sim mặc định (TASK_P16f).
RUNS: Final[dict[str, str]] = {
    "k2": "20261103-123426_K2-P15a",
    "k4": "20261103-125324_K4-P15a",
    "k7": "20261103-130806_K7-P15a",
    "nightrain": "20261103-132746_NightRain-P15a",
}
SCENARIO_ORDER: Final[tuple[str, ...]] = ("k2", "k4", "k7", "nightrain", "real")
SIM_SCENARIOS: Final[tuple[str, ...]] = ("k2", "k4", "k7", "nightrain")
SCENARIO_LABEL: Final[dict[str, str]] = {
    "k2": "K2",
    "k4": "K4",
    "k7": "K7",
    "nightrain": "NightRain",
    "real": "R4 video thật",
}

#: Hai cặp cổng cho 2 run song song (TASK_P16f: 8040+, 8050+).
PORT_SLOTS: Final[tuple[tuple[int, int], ...]] = ((8040, 8041), (8050, 8051))
#: Cổng cho baseline video thật — tránh 8020–8033 của coders-1/coders-2 và 8040/8050 ở trên.
REAL_API_PORT: Final = 8061
REAL_GATE_PORT: Final = 8060

#: Ngưỡng đĩa (TASK_P16f mục 1).
MIN_FREE_GB: Final = 3.0

#: Ngưỡng nghiệm thu (SPEC_P16 mục 3 + ANS_22).
K2_HARD_BREAKS_TOTAL: Final = 6
K2_HARD_BREAKS_MAX: Final = 3
K2_CAM2_GID_RATIO: Final = 0.75
K2_OCCUPANCY: Final = 0.95
K4_HARD_BREAKS_TOTAL: Final = 12
K4_HARD_BREAKS_MAX: Final = 4
K4_GATE_DELTA: Final = 1
REAL_NEW_GID_GROWTH: Final = 0.10
REAL_OCCUPANCY_DROP: Final = 0.005  # 0,5 điểm %

BASELINE_BEFORE: Final = OUT_DIR / "baseline_before.json"
BASELINE_AFTER: Final = OUT_DIR / "baseline_after.json"


class InsufficientSpace(RuntimeError):
    """Ổ còn dưới ngưỡng GB — phải dừng, không chạy tiếp."""


# ---------------------------------------------------------------------------------------
# Dòng kết quả
# ---------------------------------------------------------------------------------------
@dataclass
class Row:
    """Một tiêu chí trong bảng nghiệm thu.

    ``passed = None`` nghĩa là **không chấm** (K7/đêm mưa chỉ ghi số, hoặc không đo được).
    """

    scenario: str
    metric: str
    before: Any
    after: Any
    threshold: str
    passed: bool | None
    fmt: str = "int"  # "int" | "pct" | "text"
    note: str = ""

    def cell(self, value: Any) -> str:
        if value is None:
            return "không đo"
        if self.fmt == "pct":
            return f"{float(value) * 100:.1f} %"
        if self.fmt == "int":
            return str(int(value))
        return str(value)

    @property
    def before_text(self) -> str:
        return self.cell(self.before)

    @property
    def after_text(self) -> str:
        return self.cell(self.after)

    @property
    def verdict(self) -> str:
        if self.passed is None:
            return "— (ghi số)"
        return "ĐẠT" if self.passed else "KHÔNG ĐẠT"

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "metric": self.metric,
            "before": self.before,
            "after": self.after,
            "before_text": self.before_text,
            "after_text": self.after_text,
            "threshold": self.threshold,
            "passed": self.passed,
            "verdict": self.verdict,
            "note": self.note,
        }


def _row(
    scenario: str,
    metric: str,
    before: Any,
    after: Any,
    threshold: str,
    passed: bool | None,
    *,
    fmt: str = "int",
    note: str = "",
) -> Row:
    return Row(
        scenario=scenario,
        metric=metric,
        before=before,
        after=after,
        threshold=threshold,
        passed=passed,
        fmt=fmt,
        note=note,
    )


def _and(*values: bool | None) -> bool | None:
    """AND ba trạng thái: có False ⇒ False; có None ⇒ None; còn lại True."""
    if any(value is False for value in values):
        return False
    if any(value is None for value in values):
        return None
    return True


def _gate_equal(controller: int | None, ideal: int | None) -> bool | None:
    """Hai bên đều đo được mới chấm; thiếu một bên ⇒ ``None`` (không đo), không phải False."""
    if controller is None or ideal is None:
        return None
    return controller == ideal


def _le(value: float | None, limit: float) -> bool | None:
    return None if value is None else value <= limit


def _ge(value: float | None, limit: float) -> bool | None:
    return None if value is None else value >= limit


# ---------------------------------------------------------------------------------------
# Gom số đo
# ---------------------------------------------------------------------------------------
@dataclass
class Bundle:
    """Số đo của một run, đã chuẩn hoá về các tiêu chí của P16."""

    gate_in: int | None = None
    gate_out: int | None = None
    ideal_in: int | None = None
    ideal_out: int | None = None
    hard_breaks_total: int | None = None
    hard_breaks_max: int | None = None
    gid_reuse: int | None = None
    cam2_gid_ratio: float | None = None
    occupancy: float | None = None
    sources: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "gate_in": self.gate_in,
            "gate_out": self.gate_out,
            "ideal_in": self.ideal_in,
            "ideal_out": self.ideal_out,
            "hard_breaks_total": self.hard_breaks_total,
            "hard_breaks_max": self.hard_breaks_max,
            "gid_reuse": self.gid_reuse,
            "cam2_gid_ratio": self.cam2_gid_ratio,
            "occupancy": self.occupancy,
            "sources": dict(self.sources),
        }

    @property
    def gate_in_text(self) -> str | None:
        return None if self.gate_in is None or self.ideal_in is None else f"{self.gate_in}/{self.ideal_in}"

    @property
    def gate_out_text(self) -> str | None:
        return (
            None
            if self.gate_out is None or self.ideal_out is None
            else f"{self.gate_out}/{self.ideal_out}"
        )

    def gate_in_delta(self) -> int | None:
        if self.gate_in is None or self.ideal_in is None:
            return None
        return self.gate_in - self.ideal_in

    def gate_out_delta(self) -> int | None:
        if self.gate_out is None or self.ideal_out is None:
            return None
        return self.gate_out - self.ideal_out


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def bundle_from(
    gate: dict[str, Any] | None,
    metrics: dict[str, Any] | None,
    track: dict[str, Any] | None,
    *,
    sources: dict[str, str] | None = None,
) -> Bundle:
    """Dựng :class:`Bundle` từ 3 JSON của các tool (thiếu phần nào thì để ``None``)."""
    bundle = Bundle(sources=dict(sources or {}))
    if gate is not None and gate.get("ok") is not False:
        controller = gate.get("controller") or {}
        ideal = gate.get("gate_ideal") or {}
        bundle.gate_in = _as_int(controller.get("gate_in"))
        bundle.gate_out = _as_int(controller.get("gate_out"))
        bundle.ideal_in = _as_int(ideal.get("entry"))
        bundle.ideal_out = _as_int(ideal.get("exit"))
    if track is not None and not track.get("error"):
        per_car = track.get("per_car") or {}
        bundle.hard_breaks_total = _as_int(per_car.get("hard_breaks_total"))
        bundle.hard_breaks_max = _as_int(per_car.get("hard_breaks_max"))
        bundle.gid_reuse = _as_int(per_car.get("gid_reuse_count"))
        frame_recall = track.get("frame_recall") or {}
        cam2 = frame_recall.get("cam2") or {}
        bundle.cam2_gid_ratio = _as_float(cam2.get("gid_ratio"))
    if metrics is not None:
        occupancy = metrics.get("occupancy") or {}
        bundle.occupancy = _as_float(occupancy.get("accuracy"))
    return bundle


def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def stored_bundle(run_dir: Path) -> Bundle:
    """Số "trước sửa": đọc kết quả **đã lưu** trong thư mục run (không chạy gì)."""
    gate_path = run_dir / "m1_gate" / "gate_result.json"
    metrics_path = run_dir / "m1" / "metrics.json"
    gate = _load_json(gate_path)
    metrics = _load_json(metrics_path)
    track = (metrics or {}).get("track") if metrics else None
    if not isinstance(track, dict):
        track = None
    sources = {}
    if gate is not None:
        sources["gate"] = str(gate_path)
    if metrics is not None:
        sources["metrics"] = str(metrics_path)
    return bundle_from(gate, metrics, track, sources=sources)


# ---------------------------------------------------------------------------------------
# Chấm điểm
# ---------------------------------------------------------------------------------------
def score_k2(before: Bundle, after: Bundle) -> list[Row]:
    """K2: cổng khớp ideal visible 3/3, đứt thật ≤ 6 (mỗi xe ≤ 3), cam2 GID ≥ 75 %, occupancy ≥ 95 %."""
    scenario = SCENARIO_LABEL["k2"]
    gate_in_ok = _gate_equal(after.gate_in, after.ideal_in)
    gate_out_ok = _gate_equal(after.gate_out, after.ideal_out)
    return [
        _row(
            scenario,
            "cổng vào (controller/GT lý tưởng)",
            before.gate_in_text,
            after.gate_in_text,
            "= 3/3, khớp gt_gate_ideal visible",
            gate_in_ok,
            fmt="text",
        ),
        _row(
            scenario,
            "cổng ra (controller/GT lý tưởng)",
            before.gate_out_text,
            after.gate_out_text,
            "= 3/3, khớp gt_gate_ideal visible",
            gate_out_ok,
            fmt="text",
        ),
        _row(
            scenario,
            "đứt THẬT tổng",
            before.hard_breaks_total,
            after.hard_breaks_total,
            f"≤ {K2_HARD_BREAKS_TOTAL}",
            _le(after.hard_breaks_total, K2_HARD_BREAKS_TOTAL),
        ),
        _row(
            scenario,
            "đứt THẬT max/xe",
            before.hard_breaks_max,
            after.hard_breaks_max,
            f"≤ {K2_HARD_BREAKS_MAX}",
            _le(after.hard_breaks_max, K2_HARD_BREAKS_MAX),
        ),
        _row(
            scenario,
            "cam2 frame có GID",
            before.cam2_gid_ratio,
            after.cam2_gid_ratio,
            f"≥ {K2_CAM2_GID_RATIO * 100:.0f} %",
            _ge(after.cam2_gid_ratio, K2_CAM2_GID_RATIO),
            fmt="pct",
        ),
        _row(
            scenario,
            "occupancy frame-ô",
            before.occupancy,
            after.occupancy,
            f"≥ {K2_OCCUPANCY * 100:.0f} %",
            _ge(after.occupancy, K2_OCCUPANCY),
            fmt="pct",
        ),
    ]


def score_k4(before: Bundle, after: Bundle) -> list[Row]:
    """K4: GID dùng chung = 0, đứt thật ≤ 12 (mỗi xe ≤ 4), cổng lệch ≤ 1 mỗi chiều."""
    scenario = SCENARIO_LABEL["k4"]
    delta_in = after.gate_in_delta()
    delta_out = after.gate_out_delta()
    delta_text = (
        None
        if delta_in is None or delta_out is None
        else f"{delta_in:+d}/{delta_out:+d}"
    )
    delta_ok = _and(
        None if delta_in is None else abs(delta_in) <= K4_GATE_DELTA,
        None if delta_out is None else abs(delta_out) <= K4_GATE_DELTA,
    )
    return [
        _row(
            scenario,
            "GID dùng chung",
            before.gid_reuse,
            after.gid_reuse,
            "= 0",
            None if after.gid_reuse is None else after.gid_reuse == 0,
        ),
        _row(
            scenario,
            "đứt THẬT tổng",
            before.hard_breaks_total,
            after.hard_breaks_total,
            f"≤ {K4_HARD_BREAKS_TOTAL}",
            _le(after.hard_breaks_total, K4_HARD_BREAKS_TOTAL),
        ),
        _row(
            scenario,
            "đứt THẬT max/xe",
            before.hard_breaks_max,
            after.hard_breaks_max,
            f"≤ {K4_HARD_BREAKS_MAX}",
            _le(after.hard_breaks_max, K4_HARD_BREAKS_MAX),
        ),
        _row(
            scenario,
            "cổng lệch vào/ra (controller − ideal)",
            None,
            delta_text,
            f"|lệch| ≤ {K4_GATE_DELTA} mỗi chiều",
            delta_ok,
            fmt="text",
        ),
    ]


def score_numbers_only(before: Bundle, after: Bundle, scenario: str) -> list[Row]:
    """K7 / đêm mưa: chỉ in số, không chặn nghiệm thu (SPEC_P16 R7, ANS_22)."""
    return [
        _row(
            scenario,
            "cổng vào/ra (controller/ideal)",
            f"{before.gate_in_text or 'không đo'} · {before.gate_out_text or 'không đo'}",
            f"{after.gate_in_text or 'không đo'} · {after.gate_out_text or 'không đo'}",
            "chỉ ghi số",
            None,
            fmt="text",
        ),
        _row(
            scenario,
            "đứt THẬT tổng",
            before.hard_breaks_total,
            after.hard_breaks_total,
            "chỉ ghi số",
            None,
        ),
        _row(
            scenario,
            "GID dùng chung",
            before.gid_reuse,
            after.gid_reuse,
            "chỉ ghi số",
            None,
        ),
        _row(
            scenario,
            "cam2 frame có GID",
            before.cam2_gid_ratio,
            after.cam2_gid_ratio,
            "chỉ ghi số",
            None,
            fmt="pct",
        ),
        _row(
            scenario,
            "occupancy frame-ô",
            before.occupancy,
            after.occupancy,
            "chỉ ghi số",
            None,
            fmt="pct",
        ),
    ]


def _manual_deviation(doc: dict[str, Any] | None, key: str) -> int | None:
    """``|controller - đếm tay|`` tổng các session có đếm tay."""
    if not doc:
        return None
    total = 0
    measured = False
    controller_key = "controller_entry" if key == "in" else "controller_exit"
    manual_key = "vehicles_in" if key == "in" else "vehicles_out"
    for session in doc.get("sessions") or []:
        gate = session.get("gate") or {}
        manual = gate.get("manual") or {}
        controller = gate.get(controller_key)
        expected = manual.get(manual_key)
        if controller is None or expected is None:
            continue
        measured = True
        total += abs(int(controller) - int(expected))
    return total if measured else None


def _mean_occupancy(doc: dict[str, Any] | None) -> float | None:
    if not doc:
        return None
    values = [
        value
        for value in (
            (session.get("occupancy") or {}).get("mean_occupied_ratio")
            for session in doc.get("sessions") or []
        )
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    return sum(float(value) for value in values) / len(values) if values else None


def score_real(
    before_doc: dict[str, Any] | None,
    after_doc: dict[str, Any] | None,
    *,
    missing_note: str = "",
) -> list[Row]:
    """R4: video thật không thoái lui so ``baseline_before.json``."""
    scenario = SCENARIO_LABEL["real"]
    before_totals = (before_doc or {}).get("totals") or {}
    after_totals = (after_doc or {}).get("totals") or {}
    if before_doc is None or after_doc is None:
        rows = []
        for metric, threshold in (
            ("số GID mới", f"≤ trước + {REAL_NEW_GID_GROWTH:.0%}"),
            ("[merge]", "không tăng"),
            ("[re-id]", "không tăng"),
            ("ENTRY lệch đếm tay", "không xa hơn trước"),
            ("EXIT lệch đếm tay", "không xa hơn trước"),
            ("occupancy trung bình", f"giảm ≤ {REAL_OCCUPANCY_DROP * 100:.1f} điểm"),
        ):
            rows.append(
                _row(scenario, metric, None, None, threshold, None, note=missing_note)
            )
        return rows

    new_before = _as_int(before_totals.get("new_gid"))
    new_after = _as_int(after_totals.get("new_gid"))
    new_limit = None if new_before is None else new_before * (1 + REAL_NEW_GID_GROWTH)
    merge_before = _as_int(before_totals.get("merge"))
    merge_after = _as_int(after_totals.get("merge"))
    reid_before = _as_int(before_totals.get("re_id"))
    reid_after = _as_int(after_totals.get("re_id"))
    entry_before = _manual_deviation(before_doc, "in")
    entry_after = _manual_deviation(after_doc, "in")
    exit_before = _manual_deviation(before_doc, "out")
    exit_after = _manual_deviation(after_doc, "out")
    occ_before = _mean_occupancy(before_doc)
    occ_after = _mean_occupancy(after_doc)

    return [
        _row(
            scenario,
            "số GID mới",
            new_before,
            new_after,
            f"≤ {new_limit:.2f} (trước + {REAL_NEW_GID_GROWTH:.0%})"
            if new_limit is not None
            else f"≤ trước + {REAL_NEW_GID_GROWTH:.0%}",
            None
            if new_limit is None or new_after is None
            else new_after <= new_limit,
            note="trước = baseline_before.json",
        ),
        _row(
            scenario,
            "[merge] đã hoàn tất",
            merge_before,
            merge_after,
            "≤ trước (không tăng)",
            None
            if merge_before is None or merge_after is None
            else merge_after <= merge_before,
        ),
        _row(
            scenario,
            "[re-id]",
            reid_before,
            reid_after,
            "≤ trước (không tăng)",
            None
            if reid_before is None or reid_after is None
            else reid_after <= reid_before,
        ),
        _row(
            scenario,
            "ENTRY lệch đếm tay",
            entry_before,
            entry_after,
            "≤ trước (không xa hơn)",
            None
            if entry_before is None or entry_after is None
            else entry_after <= entry_before,
        ),
        _row(
            scenario,
            "EXIT lệch đếm tay",
            exit_before,
            exit_after,
            "≤ trước (không xa hơn)",
            None
            if exit_before is None or exit_after is None
            else exit_after <= exit_before,
        ),
        _row(
            scenario,
            "occupancy trung bình (3 session)",
            occ_before,
            occ_after,
            f"giảm ≤ {REAL_OCCUPANCY_DROP * 100:.1f} điểm",
            None
            if occ_before is None or occ_after is None
            else occ_after >= occ_before - REAL_OCCUPANCY_DROP,
            fmt="pct",
        ),
    ]


def score_all(
    scenarios: list[str],
    *,
    sim_results: dict[str, dict[str, Any]],
    real_before: dict[str, Any] | None,
    real_after: dict[str, Any] | None,
    real_missing_note: str = "",
) -> list[Row]:
    """Sinh toàn bộ dòng kết quả theo thứ tự yêu cầu."""
    rows: list[Row] = []
    for name in scenarios:
        if name == "real":
            rows.extend(
                score_real(real_before, real_after, missing_note=real_missing_note)
            )
            continue
        result = sim_results.get(name) or {}
        before = result.get("before") or Bundle()
        after = result.get("after") or Bundle()
        label = SCENARIO_LABEL[name]
        if name == "k2":
            rows.extend(score_k2(before, after))
        elif name == "k4":
            rows.extend(score_k4(before, after))
        else:
            rows.extend(score_numbers_only(before, after, label))
    return rows


# ---------------------------------------------------------------------------------------
# Đĩa + gọi tool
# ---------------------------------------------------------------------------------------
def free_gb(path: Path) -> float:
    usage = shutil.disk_usage(path)
    return usage.free / (1024**3)


def ensure_free_space(path: Path, min_gb: float = MIN_FREE_GB) -> float:
    """Trả số GB trống; dưới ngưỡng thì ném :class:`InsufficientSpace` (dừng, báo rõ)."""
    path.mkdir(parents=True, exist_ok=True)
    available = free_gb(path)
    if available < min_gb:
        raise InsufficientSpace(
            f"Chỉ còn {available:.2f} GB trống trên ổ của {path} (ngưỡng {min_gb:.1f} GB). "
            "Dừng theo quy định tiết kiệm đĩa — dọn bớt rồi chạy lại."
        )
    return available


def _frames_in(run_dir: Path) -> int:
    path = run_dir / "gt_frames.csv"
    try:
        with path.open(encoding="utf-8") as handle:
            return max(0, sum(1 for _ in handle) - 1)
    except OSError:
        return 0


def _timeout_for(frames: int) -> float:
    """Như ``m1_gate_eval``: replay realtime ~25 fps, nhân 3 rồi cộng biên."""
    return max(300.0, frames / 25.0 * 3.0 + 300.0)


def run_tool(
    tool: str,
    args: list[str],
    log_path: Path,
    timeout_s: float,
) -> dict[str, Any]:
    """Gọi một tool bằng ``sys.executable`` và ghi log; **không** ném khi exit != 0.

    ``m1_gate_eval`` trả 1 khi cổng lệch, nên exit code không phải lỗi hạ tầng. Lỗi đọc
    được từ JSON của tool; ở đây chỉ cần ghi lại mã trả về để REPORT nói rõ.
    """
    command = [sys.executable, str(TOOLS_DIR / f"{tool}.py")] + args
    started = time.monotonic()
    outcome: dict[str, Any] = {"tool": tool, "command": command, "log": str(log_path)}
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        completed = subprocess.run(
            command,
            cwd=str(TOOLS_DIR),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        log_path.write_text(output, encoding="utf-8")
        outcome["returncode"] = completed.returncode
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or "") + (error.stderr or "")
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        log_path.write_text(output, encoding="utf-8")
        outcome["returncode"] = None
        outcome["error"] = f"quá {timeout_s:.0f} s"
    except OSError as error:
        log_path.write_text(f"{type(error).__name__}: {error}\n", encoding="utf-8")
        outcome["returncode"] = None
        outcome["error"] = f"{type(error).__name__}: {error}"
    outcome["seconds"] = round(time.monotonic() - started, 1)
    return outcome


def measure_run(
    scenario: str,
    run_dir: Path,
    ports: tuple[int, int],
    out_dir: Path,
) -> dict[str, Any]:
    """Chạy 3 tool cho một run (occupancy/replay → track → cổng) và gom số sau sửa."""
    api_port, gate_port = ports
    frames = _frames_in(run_dir)
    timeout_s = _timeout_for(frames)
    work_out = out_dir / OUTPUT_SUBDIR
    before = stored_bundle(run_dir)
    calls: list[dict[str, Any]] = []
    started = time.monotonic()

    calls.append(
        run_tool(
            "m1_eval",
            [str(run_dir), "--api-port", str(api_port)],
            work_out / f"{run_dir.name}__m1_eval.log",
            timeout_s,
        )
    )
    track_json = work_out / f"{run_dir.name}__track.json"
    calls.append(
        run_tool(
            "m1_track_eval",
            [str(run_dir), "--json", str(track_json)],
            work_out / f"{run_dir.name}__m1_track_eval.log",
            timeout_s,
        )
    )
    calls.append(
        run_tool(
            "m1_gate_eval",
            [str(run_dir), "--api-port", str(api_port), "--gate-port", str(gate_port)],
            work_out / f"{run_dir.name}__m1_gate_eval.log",
            timeout_s,
        )
    )

    gate = _load_json(run_dir / "m1_gate" / "gate_result.json")
    metrics = _load_json(run_dir / "m1" / "metrics.json")
    track = _load_json(track_json)
    if track is None:
        track = ((metrics or {}).get("track") if metrics else None) or None
    if not isinstance(track, dict):
        track = None
    after = bundle_from(
        gate,
        metrics,
        track,
        sources={
            "gate": str(run_dir / "m1_gate" / "gate_result.json"),
            "metrics": str(run_dir / "m1" / "metrics.json"),
            "track": str(track_json),
        },
    )
    errors = []
    if gate is None or gate.get("ok") is False:
        errors.append("m1_gate_eval không ghi được gate_result.json")
    if metrics is None:
        errors.append("m1_eval không ghi được metrics.json")
    if track is None:
        errors.append("m1_track_eval không ghi được JSON")
    return {
        "scenario": scenario,
        "run": run_dir.name,
        "run_dir": str(run_dir),
        "frames": frames,
        "ports": {"api": api_port, "gate": gate_port},
        "seconds": round(time.monotonic() - started, 1),
        "before": before,
        "after": after,
        "calls": calls,
        "errors": errors,
    }


def measure_sim_runs(
    names: list[str],
    out_dir: Path,
    *,
    runs_dir: Path = RUNS_DIR,
) -> dict[str, dict[str, Any]]:
    """Chạy các run sim, **song song tối đa 2** (mỗi run một cặp cổng riêng)."""
    results: dict[str, dict[str, Any]] = {}
    for start in range(0, len(names), 2):
        pair = names[start : start + 2]
        with ThreadPoolExecutor(max_workers=len(pair)) as pool:
            futures = {
                pool.submit(
                    measure_run,
                    name,
                    runs_dir / RUNS[name],
                    PORT_SLOTS[index % len(PORT_SLOTS)],
                    out_dir,
                ): name
                for index, name in enumerate(pair)
            }
            for future, name in futures.items():
                results[name] = future.result()
    return results


def run_real_baseline(
    out_dir: Path,
    *,
    min_free_gb: float = MIN_FREE_GB,
    timeout_s: float = 3600.0,
) -> dict[str, Any]:
    """Chạy ``real_baseline.py`` cho trạng thái **sau sửa** và ghi ``baseline_after.json``."""
    ensure_free_space(out_dir, min_free_gb)
    target = out_dir / "baseline_after.json"
    markdown = out_dir / "baseline_after.md"
    return run_tool(
        "real_baseline",
        [
            "--code-source",
            "worktree",
            "--config-set",
            "root",
            "--tag",
            "after",
            "--out",
            str(target),
            "--markdown",
            str(markdown),
            "--api-port",
            str(REAL_API_PORT),
            "--gate-port",
            str(REAL_GATE_PORT),
            "--min-free-gb",
            str(min_free_gb),
        ],
        out_dir / OUTPUT_SUBDIR / "real_baseline__after.log",
        timeout_s,
    )


# ---------------------------------------------------------------------------------------
# In + ghi
# ---------------------------------------------------------------------------------------
def render_markdown(document: dict[str, Any]) -> str:
    """Bảng markdown dán thẳng vào REPORT."""
    lines = [
        "# P16f — bảng nghiệm thu P16",
        "",
        f"- lệnh: `{document['command']}`",
        f"- chạy lúc: {document['generated_at']} · mất {document['seconds']:.0f} s",
        f"- đĩa trống trước khi chạy: {document['free_gb']:.1f} GB (ngưỡng {MIN_FREE_GB:.1f} GB)",
        "",
        "| kịch bản | chỉ số | trước sửa | sau sửa | ngưỡng | kết quả | ghi chú |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in document["rows"]:
        note = row["note"].replace("|", "/")
        lines.append(
            f"| {row['scenario']} | {row['metric']} | {row['before_text']} | "
            f"{row['after_text']} | {row['threshold']} | {row['verdict']} | {note} |"
        )
    totals = document["summary"]
    lines += [
        "",
        f"**Tổng: {totals['pass']} ĐẠT · {totals['fail']} KHÔNG ĐẠT · "
        f"{totals['unmeasured']} không chấm ({totals['verdict']})**",
        "",
        "## Chi tiết chạy",
        "",
    ]
    for name, run in document["runs"].items():
        after = run["after"]
        lines.append(
            f"- `{run['run']}` ({name}, {run['frames']} frame, {run['seconds']:.0f} s, "
            f"cổng {run['ports']['api']}/{run['ports']['gate']}): "
            f"gate {after.get('gate_in')}/{after.get('gate_out')} (ideal "
            f"{after.get('ideal_in')}/{after.get('ideal_out')}), "
            f"đứt thật {after.get('hard_breaks_total')} (max {after.get('hard_breaks_max')}), "
            f"GID dùng chung {after.get('gid_reuse')}"
        )
        for call in run["calls"]:
            lines.append(
                f"  - `{call['tool']}` rc={call['returncode']} {call['seconds']:.0f} s "
                f"→ `{call['log']}`"
            )
    if document.get("real"):
        real = document["real"]
        lines += ["", "## Video thật (R4)", ""]
        for key, path in (("before", BASELINE_BEFORE), ("after", BASELINE_AFTER)):
            exists = "có" if Path(path).is_file() else "KHÔNG có"
            lines.append(f"- baseline {key}: `{path}` ({exists})")
        if real.get("call"):
            lines.append(
                f"- lệnh after: rc={real['call']['returncode']} "
                f"{real['call']['seconds']:.0f} s → `{real['call']['log']}`"
            )
        for session in (real.get("after_doc") or {}).get("sessions") or []:
            gate = session.get("gate") or {}
            manual = gate.get("manual") or {}
            lines.append(
                f"  - `{session['session']}`: new GID {session['identity']['new_gid']}, "
                f"merge {session['identity']['merge']}, re-id {session['identity']['re_id']}, "
                f"ENTRY {gate.get('controller_entry')}, EXIT {gate.get('controller_exit')}, "
                f"đếm tay {manual.get('vehicles_in', '?')}/{manual.get('vehicles_out', '?')}, "
                f"occupancy {(session.get('occupancy') or {}).get('mean_occupied_ratio')}"
            )
    notes = document.get("notes") or []
    if notes:
        lines += ["", "## Ghi chú", ""]
        lines += [f"- {note}" for note in notes]
    return "\n".join(lines) + "\n"


def render_table(document: dict[str, Any]) -> str:
    """Bảng cho terminal."""
    header = (
        f"{'kịch bản':18}{'chỉ số':38}{'trước':>10}{'sau':>10}"
        f"{'ngưỡng':>28}  kết quả"
    )
    lines = ["", "P16f — bảng nghiệm thu", header, "-" * len(header)]
    current = None
    for row in document["rows"]:
        if row["scenario"] != current:
            current = row["scenario"]
            lines.append("")
        lines.append(
            f"{row['scenario']:18}{row['metric'][:36]:38}"
            f"{row['before_text']:>10}{row['after_text']:>10}"
            f"{row['threshold'][:26]:>28}  {row['verdict']}"
        )
    totals = document["summary"]
    lines += [
        "",
        f"Tổng: {totals['pass']} ĐẠT · {totals['fail']} KHÔNG ĐẠT · "
        f"{totals['unmeasured']} không chấm → {totals['verdict']}",
    ]
    return "\n".join(lines)


def summarize(rows: list[Row]) -> dict[str, Any]:
    passed = sum(1 for row in rows if row.passed is True)
    failed = sum(1 for row in rows if row.passed is False)
    unmeasured = sum(1 for row in rows if row.passed is None)
    verdict = "ĐẠT" if failed == 0 and unmeasured == 0 else "KHÔNG ĐẠT"
    return {
        "pass": passed,
        "fail": failed,
        "unmeasured": unmeasured,
        "verdict": verdict,
    }


# ---------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------
def parse_only(text: str | None) -> list[str]:
    """``--only k2,k4`` → ``["k2", "k4"]``; mặc định đủ thứ tự :data:`SCENARIO_ORDER`."""
    if not text:
        return list(SCENARIO_ORDER)
    wanted = [part.strip().lower() for part in text.split(",") if part.strip()]
    unknown = [part for part in wanted if part not in SCENARIO_ORDER]
    if unknown:
        raise ValueError(
            f"--only không biết {unknown}; chọn trong {list(SCENARIO_ORDER)}"
        )
    return [name for name in SCENARIO_ORDER if name in wanted]


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="P16f — nghiệm thu P16 bằng một lệnh (gọi lại các tool có sẵn, in bảng ĐẠT/KHÔNG)"
    )
    result.add_argument(
        "--only",
        default=None,
        help="chỉ chạy một phần, ví dụ 'k2,k4' (k2,k4,k7,nightrain,real)",
    )
    result.add_argument(
        "--skip-real",
        action="store_true",
        help="bỏ baseline video thật (chạy nhanh khi đang sửa)",
    )
    result.add_argument(
        "--out-dir",
        type=Path,
        default=OUT_DIR,
        help=f"thư mục ghi kết quả (mặc định {OUT_DIR})",
    )
    result.add_argument(
        "--runs-dir",
        type=Path,
        default=RUNS_DIR,
        help=f"thư mục chứa run sim (mặc định {RUNS_DIR})",
    )
    result.add_argument(
        "--min-free-gb",
        type=float,
        default=MIN_FREE_GB,
        help=f"dừng nếu ổ còn dưới ngưỡng này (mặc định {MIN_FREE_GB:.1f} GB)",
    )
    return result


def build_command(args: argparse.Namespace) -> str:
    """Dựng lại lệnh đã chạy để ghi vào REPORT (cờ bật/tắt phải đúng kiểu argparse)."""
    parts = ["p16_accept.py"]
    if args.only:
        parts += ["--only", str(args.only)]
    if args.skip_real:
        parts.append("--skip-real")
    parts += [
        "--out-dir",
        str(args.out_dir),
        "--runs-dir",
        str(args.runs_dir),
        "--min-free-gb",
        f"{args.min_free_gb:g}",
    ]
    return " ".join(parts)


def build_document(
    rows: list[Row],
    *,
    command: str,
    seconds: float,
    available_gb: float,
    runs: dict[str, dict[str, Any]],
    real: dict[str, Any] | None,
    notes: list[str],
) -> dict[str, Any]:
    def _run_doc(result: dict[str, Any]) -> dict[str, Any]:
        return {
            "run": result["run"],
            "run_dir": result["run_dir"],
            "frames": result["frames"],
            "ports": result["ports"],
            "seconds": result["seconds"],
            "before": (result["before"] or Bundle()).as_dict(),
            "after": (result["after"] or Bundle()).as_dict(),
            "calls": result["calls"],
            "errors": result["errors"],
        }

    return {
        "schema_version": 1,
        "tool": "sim3d/tools/p16_accept.py",
        "phase": "P16f",
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "command": command,
        "seconds": seconds,
        "free_gb": available_gb,
        "thresholds": {
            "k2": {
                "hard_breaks_total": K2_HARD_BREAKS_TOTAL,
                "hard_breaks_max": K2_HARD_BREAKS_MAX,
                "cam2_gid_ratio": K2_CAM2_GID_RATIO,
                "occupancy": K2_OCCUPANCY,
                "gate": "khớp gt_gate_ideal visible (3/3 vào, 3/3 ra)",
            },
            "k4": {
                "hard_breaks_total": K4_HARD_BREAKS_TOTAL,
                "hard_breaks_max": K4_HARD_BREAKS_MAX,
                "gid_reuse": 0,
                "gate_delta": K4_GATE_DELTA,
            },
            "real": {
                "new_gid_growth": REAL_NEW_GID_GROWTH,
                "occupancy_drop": REAL_OCCUPANCY_DROP,
                "merge_reid": "không tăng",
                "entry_exit": "không xa hơn đếm tay",
            },
        },
        "rows": [row.to_dict() for row in rows],
        "summary": summarize(rows),
        "runs": {name: _run_doc(result) for name, result in runs.items()},
        "real": real,
        "notes": notes,
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parser().parse_args(argv)

    try:
        scenarios = parse_only(args.only)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if args.skip_real and "real" in scenarios:
        scenarios = [name for name in scenarios if name != "real"]

    out_dir = args.out_dir.resolve()
    runs_dir = args.runs_dir.resolve()
    command = build_command(args)

    started = time.monotonic()
    notes: list[str] = []

    try:
        available = ensure_free_space(out_dir, args.min_free_gb)
    except InsufficientSpace as error:
        print(f"\nDỪNG: {error}", file=sys.stderr)
        return 3
    print(f"Ổ còn {available:.1f} GB trống (ngưỡng {args.min_free_gb:.1f} GB) — chạy tiếp.")

    missing_runs = [
        name for name in scenarios if name != "real" and not (runs_dir / RUNS[name]).is_dir()
    ]
    if missing_runs:
        message = f"Không thấy thư mục run cho {missing_runs} trong {runs_dir}"
        print(f"DỪNG: {message}", file=sys.stderr)
        return 3

    sim_names = [name for name in scenarios if name != "real"]
    runs: dict[str, dict[str, Any]] = {}
    if sim_names:
        print(f"\nChạy {len(sim_names)} run sim (song song 2, cổng 8040/8050)…")
        runs = measure_sim_runs(sim_names, out_dir, runs_dir=runs_dir)
        for name, result in runs.items():
            after = result["after"]
            print(
                f"  {name:10} {result['run']}: {result['seconds']:.0f} s · "
                f"gate {after.gate_in}/{after.gate_out} (ideal {after.ideal_in}/{after.ideal_out}) · "
                f"đứt thật {after.hard_breaks_total} · GID chung {after.gid_reuse}"
            )
            for message in result["errors"]:
                print(f"    LỖI: {message}")
            notes.extend(f"{name}: {message}" for message in result["errors"])

    real: dict[str, Any] | None = None
    real_before_doc: dict[str, Any] | None = None
    real_after_doc: dict[str, Any] | None = None
    real_missing_note = ""
    if "real" in scenarios:
        real_before_doc = _load_json(BASELINE_BEFORE)
        if real_before_doc is None:
            real_missing_note = f"không thấy {BASELINE_BEFORE} — chưa so được R4"
            notes.append(real_missing_note)
        print("\nChạy baseline video thật (after)…")
        try:
            call = run_real_baseline(out_dir, min_free_gb=args.min_free_gb)
        except InsufficientSpace as error:
            print(f"\nDỪNG: {error}", file=sys.stderr)
            return 3
        real_after_doc = _load_json(out_dir / "baseline_after.json")
        print(
            f"  real_baseline: rc={call['returncode']} · {call['seconds']:.0f} s "
            f"→ {out_dir / 'baseline_after.json'}"
        )
        if real_after_doc is None:
            notes.append("real_baseline không ghi được baseline_after.json — xem log")
        real = {
            "call": call,
            "before_doc": real_before_doc,
            "after_doc": real_after_doc,
            "before_path": str(out_dir / "baseline_before.json"),
            "after_path": str(out_dir / "baseline_after.json"),
        }

    rows = score_all(
        scenarios,
        sim_results=runs,
        real_before=real_before_doc,
        real_after=real_after_doc,
        real_missing_note=real_missing_note,
    )
    document = build_document(
        rows,
        command=command,
        seconds=round(time.monotonic() - started, 1),
        available_gb=round(available, 2),
        runs=runs,
        real=real,
        notes=notes,
    )
    document["scenarios"] = scenarios

    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "p16_accept.json"
    json_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    markdown_path = out_dir / "p16_accept.md"
    markdown_path.write_text(render_markdown(document), encoding="utf-8")

    print(render_table(document))
    print(f"\nĐã ghi: {json_path}\n         {markdown_path}")
    return 0 if document["summary"]["verdict"] == "ĐẠT" else 1


if __name__ == "__main__":
    raise SystemExit(main())

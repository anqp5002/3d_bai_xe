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
| R4 video thật | ``real_baseline.py --config-set root`` × N lần mỗi trạng thái mã | ``out/baseline_{before,after}_run<i>.json`` |

**P16j — ``--repeat-real N`` (mặc định 3):** mỗi trạng thái mã (``before`` = HEAD,
``after`` = worktree) chạy ``real_baseline.py`` **N lần**, vì ENTRY/EXIT trên video thật
dao động giữa các lần (nguồn cấp cổng/`source_unavailable`). Báo **từng lần + trung bình +
min**; R4 chấm theo **trung bình**:

- trung bình EXIT(after) ≥ trung bình EXIT(before);
- trung bình ENTRY(after) không giảm;
- các tiêu chí R4 khác giữ nguyên (GID mới ≤ trước + 10 %, merge/re-id không tăng,
  occupancy không giảm quá 0,5 điểm).

Chạy::

    sim3d\\server\\.venv\\Scripts\\python.exe sim3d/tools/p16_accept.py
    … --only k2,k4 --skip-real      # chạy nhanh khi đang sửa
    … --only real --repeat-real 5   # đo R4 5 lần mỗi trạng thái (mặc định 3)

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
import glob
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

#: Số lần chạy ``real_baseline`` cho MỖI trạng thái mã (TASK_P16j / ANS_24).
REAL_REPEAT_DEFAULT: Final = 3

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


class ReuseBeforeError(RuntimeError):
    """``--reuse-before`` trỏ tới file thiếu/sai — dừng và báo rõ, không đoán số."""


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
    fmt: str = "int"  # "int" | "pct" | "float" | "text"
    note: str = ""

    def cell(self, value: Any) -> str:
        if value is None:
            return "không đo"
        if self.fmt == "pct":
            return f"{float(value) * 100:.1f} %"
        if self.fmt == "float":
            return f"{float(value):.2f}"
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


@dataclass
class RealRun:
    """Một lần chạy ``real_baseline.py`` cho một trạng thái mã (P16j)."""

    state: str  # "before" | "after"
    index: int  # 1..N
    path: Path
    doc: dict[str, Any] | None
    call: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.doc is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "index": self.index,
            "path": str(self.path),
            "ok": self.ok,
            "call": self.call,
            "totals": real_run_totals(self.doc),
        }


def real_run_totals(doc: dict[str, Any] | None) -> dict[str, Any]:
    """Các số R4 của **một lần** chạy (``None`` nếu thiếu)."""
    totals = (doc or {}).get("totals") or {}
    return {
        "entry": _as_int(totals.get("controller_entry")),
        "exit": _as_int(totals.get("controller_exit")),
        "manual_in": _as_int(totals.get("manual_vehicles_in")),
        "manual_out": _as_int(totals.get("manual_vehicles_out")),
        "new_gid": _as_int(totals.get("new_gid")),
        "merge": _as_int(totals.get("merge")),
        "re_id": _as_int(totals.get("re_id")),
        "occupancy": _mean_occupancy(doc),
    }


def aggregate_real_runs(runs: list[RealRun]) -> dict[str, dict[str, Any]]:
    """Gom N lần chạy: ``values`` (theo thứ tự), ``mean``, ``min`` cho từng chỉ số."""
    series: dict[str, list[float]] = {
        key: [] for key in ("entry", "exit", "new_gid", "merge", "re_id", "occupancy")
    }
    for run in runs:
        totals = real_run_totals(run.doc)
        for key, values in series.items():
            value = totals.get(key)
            if value is not None:
                values.append(float(value))
    result: dict[str, dict[str, Any]] = {}
    for key, values in series.items():
        result[key] = {
            "values": values,
            "mean": sum(values) / len(values) if values else None,
            "min": min(values) if values else None,
        }
    result["runs"] = len(runs)
    result["ok_runs"] = sum(1 for run in runs if run.ok)
    return result


def _fmt_values(values: list[float]) -> str:
    return "/".join(f"{value:g}" for value in values) if values else "không đo"


def score_real_repeated(
    before_runs: list[RealRun],
    after_runs: list[RealRun],
    *,
    missing_note: str = "",
) -> list[Row]:
    """R4 theo **trung bình N lần** (TASK_P16j / ANS_24).

    Tiêu chí: trung bình EXIT(after) ≥ trung bình EXIT(before); trung bình ENTRY(after)
    không giảm; các tiêu chí R4 khác giữ nguyên. ``min`` chỉ để xem độ ổn định, không chấm.
    """
    scenario = SCENARIO_LABEL["real"]
    before = aggregate_real_runs(before_runs)
    after = aggregate_real_runs(after_runs)
    before_ok = bool(before["ok_runs"])
    after_ok = bool(after["ok_runs"])
    if not before_ok or not after_ok:
        rows = []
        for metric, threshold in (
            ("ENTRY trung bình (N lần)", "after ≥ before"),
            ("EXIT trung bình (N lần)", "after ≥ before"),
            ("số GID mới (TB N lần)", f"≤ trước + {REAL_NEW_GID_GROWTH:.0%}"),
            ("[merge] đã hoàn tất (TB)", "≤ trước (không tăng)"),
            ("[re-id] (TB)", "≤ trước (không tăng)"),
            ("occupancy trung bình (TB)", f"giảm ≤ {REAL_OCCUPANCY_DROP * 100:.1f} điểm"),
        ):
            rows.append(
                _row(scenario, metric, None, None, threshold, None, note=missing_note)
            )
        return rows

    entry_before, entry_after = before["entry"]["mean"], after["entry"]["mean"]
    exit_before, exit_after = before["exit"]["mean"], after["exit"]["mean"]
    new_before, new_after = before["new_gid"]["mean"], after["new_gid"]["mean"]
    merge_before, merge_after = before["merge"]["mean"], after["merge"]["mean"]
    reid_before, reid_after = before["re_id"]["mean"], after["re_id"]["mean"]
    occ_before, occ_after = before["occupancy"]["mean"], after["occupancy"]["mean"]
    new_limit = None if new_before is None else new_before * (1 + REAL_NEW_GID_GROWTH)

    def _series_note(key: str) -> str:
        """Giá trị từng lần + min (min chỉ để xem độ ổn định, không chấm)."""
        def _num(value: float | None) -> str:
            return "không đo" if value is None else f"{value:g}"

        return (
            f"before {_fmt_values(before[key]['values'])} (min {_num(before[key]['min'])}) · "
            f"after {_fmt_values(after[key]['values'])} (min {_num(after[key]['min'])})"
        )

    def _ge_mean(before_value: float | None, after_value: float | None) -> bool | None:
        if before_value is None or after_value is None:
            return None
        return after_value >= before_value

    return [
        _row(
            scenario,
            "ENTRY trung bình (N lần)",
            entry_before,
            entry_after,
            "after ≥ before (không giảm)",
            _ge_mean(entry_before, entry_after),
            fmt="float",
            note=_series_note("entry"),
        ),
        _row(
            scenario,
            "EXIT trung bình (N lần)",
            exit_before,
            exit_after,
            "after ≥ before (không giảm)",
            _ge_mean(exit_before, exit_after),
            fmt="float",
            note=_series_note("exit"),
        ),
        _row(
            scenario,
            "số GID mới (TB N lần)",
            new_before,
            new_after,
            f"≤ {new_limit:.2f} (trước + {REAL_NEW_GID_GROWTH:.0%})"
            if new_limit is not None
            else f"≤ trước + {REAL_NEW_GID_GROWTH:.0%}",
            None if new_limit is None or new_after is None else new_after <= new_limit,
            fmt="float",
        ),
        _row(
            scenario,
            "[merge] đã hoàn tất (TB)",
            merge_before,
            merge_after,
            "≤ trước (không tăng)",
            None
            if merge_before is None or merge_after is None
            else merge_after <= merge_before,
            fmt="float",
        ),
        _row(
            scenario,
            "[re-id] (TB)",
            reid_before,
            reid_after,
            "≤ trước (không tăng)",
            None
            if reid_before is None or reid_after is None
            else reid_after <= reid_before,
            fmt="float",
        ),
        _row(
            scenario,
            "occupancy trung bình (TB)",
            occ_before,
            occ_after,
            f"giảm ≤ {REAL_OCCUPANCY_DROP * 100:.1f} điểm",
            None
            if occ_before is None or occ_after is None
            else occ_after >= occ_before - REAL_OCCUPANCY_DROP,
            fmt="pct",
        ),
    ]


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
    real_before_runs: list[RealRun] | None = None,
    real_after_runs: list[RealRun] | None = None,
) -> list[Row]:
    """Sinh toàn bộ dòng kết quả theo thứ tự yêu cầu.

    Có ``real_before_runs``/``real_after_runs`` (P16j) thì R4 chấm theo trung bình N lần;
    không có thì giữ đường cũ (một lần, so ``baseline_before.json``).
    """
    rows: list[Row] = []
    for name in scenarios:
        if name == "real":
            if real_before_runs is not None and real_after_runs is not None:
                rows.extend(
                    score_real_repeated(
                        real_before_runs, real_after_runs, missing_note=real_missing_note
                    )
                )
            else:
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
    code_source: str = "worktree",
    tag: str = "after",
    out_path: Path | None = None,
    markdown_path: Path | None = None,
    min_free_gb: float = MIN_FREE_GB,
    timeout_s: float = 3600.0,
) -> dict[str, Any]:
    """Chạy ``real_baseline.py`` một lần và trả ``run_tool`` outcome.

    ``code_source``: ``"head"`` = mã đã commit (trạng thái **before**), ``"worktree"`` = mã
    đang có trên đĩa (trạng thái **after**). ``tag`` tách thư mục chạy giữa các lần.
    """
    ensure_free_space(out_dir, min_free_gb)
    target = out_path or (out_dir / f"baseline_{tag}.json")
    markdown = markdown_path or (out_dir / f"baseline_{tag}.md")
    return run_tool(
        "real_baseline",
        [
            "--code-source",
            code_source,
            "--config-set",
            "root",
            "--tag",
            tag,
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
        out_dir / OUTPUT_SUBDIR / f"real_baseline__{tag}.log",
        timeout_s,
    )


def measure_real_state(
    state: str,
    repeat: int,
    out_dir: Path,
    *,
    min_free_gb: float = MIN_FREE_GB,
    timeout_s: float = 3600.0,
) -> list[RealRun]:
    """Chạy ``real_baseline`` **N lần** cho một trạng thái mã (P16j).

    ``state="before"`` dùng ``--code-source head``, ``state="after"`` dùng ``worktree``.
    Mỗi lần ghi ``out/baseline_<state>_run<i>.json`` và tag riêng để không ghi đè
    ``m1_gate/`` của lần trước. Kiểm đĩa **trước từng lần**.
    """
    code_source = "head" if state == "before" else "worktree"
    runs: list[RealRun] = []
    for index in range(1, repeat + 1):
        out_path = out_dir / f"baseline_{state}_run{index}.json"
        markdown_path = out_dir / f"baseline_{state}_run{index}.md"
        call = run_real_baseline(
            out_dir,
            code_source=code_source,
            tag=f"{state}{index}",
            out_path=out_path,
            markdown_path=markdown_path,
            min_free_gb=min_free_gb,
            timeout_s=timeout_s,
        )
        runs.append(
            RealRun(
                state=state,
                index=index,
                path=out_path,
                doc=_load_json(out_path),
                call=call,
            )
        )
    return runs


#: Các khoá ``totals`` bắt buộc phải có trong file before dùng lại (TASK_P16l).
REUSE_REQUIRED_TOTALS: Final[tuple[str, ...]] = (
    "controller_entry",
    "controller_exit",
    "new_gid",
    "merge",
    "re_id",
)


def expand_reuse_before(specs: list[str]) -> list[Path]:
    """Mở ``--reuse-before`` thành danh sách file: thư mục, glob, hoặc từng file.

    - thư mục → mọi ``baseline_before*.json`` trong đó (sắp theo tên);
    - có ``*``/``?``/``[`` → glob;
    - còn lại → đúng file đó.

    Không khớp gì ⇒ :class:`ReuseBeforeError` (không đoán, không chạy lại).
    """
    if not specs:
        raise ReuseBeforeError("--reuse-before cần ít nhất một file/thư mục/glob")
    paths: list[Path] = []
    for spec in specs:
        candidate = Path(spec)
        if any(char in spec for char in "*?["):
            matches = sorted(Path(match) for match in glob.glob(spec, recursive=True))
            if not matches:
                raise ReuseBeforeError(f"glob {spec!r} không khớp file nào")
            paths.extend(matches)
        elif candidate.is_dir():
            matches = sorted(candidate.glob("baseline_before*.json"))
            if not matches:
                raise ReuseBeforeError(
                    f"thư mục {candidate} không có file baseline_before*.json"
                )
            paths.extend(matches)
        else:
            paths.append(candidate)
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(path)
    return unique


def load_reuse_before(specs: list[str]) -> list[RealRun]:
    """Đọc kết quả **before đã lưu** thay vì replay (TASK_P16l).

    Kiểm rõ: file tồn tại, JSON object, có ``totals`` với đủ khoá R4, và
    ``method.code_source == "head"`` (tránh lấy nhầm file của worktree).
    """
    paths = expand_reuse_before(specs)
    runs: list[RealRun] = []
    for index, path in enumerate(paths, 1):
        if not path.is_file():
            raise ReuseBeforeError(f"không thấy file before: {path}")
        doc = _load_json(path)
        if doc is None:
            raise ReuseBeforeError(f"{path} không phải JSON object đọc được")
        totals = doc.get("totals")
        if not isinstance(totals, dict):
            raise ReuseBeforeError(f"{path} thiếu object 'totals'")
        missing = [key for key in REUSE_REQUIRED_TOTALS if key not in totals]
        if missing:
            raise ReuseBeforeError(f"{path} thiếu totals: {', '.join(missing)}")
        method = doc.get("method")
        if isinstance(method, dict) and method.get("code_source") not in (None, "head"):
            raise ReuseBeforeError(
                f"{path} là mã {method.get('code_source')!r}, không phải 'head' "
                "(không dùng làm before)"
            )
        runs.append(
            RealRun(
                state="before",
                index=index,
                path=path,
                doc=doc,
                call={"reused": True, "returncode": None, "seconds": 0.0},
            )
        )
    return runs


# ---------------------------------------------------------------------------------------
# In + ghi
# ---------------------------------------------------------------------------------------
def render_markdown(document: dict[str, Any]) -> str:
    """Bảng markdown dán thẳng vào REPORT."""
    lines = [
        "# P16j — bảng nghiệm thu P16",
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
        if real.get("repeat"):
            lines.append(
                f"- lặp: **{real['repeat']} lần mỗi trạng thái mã** "
                "(before = HEAD, after = worktree)"
            )
            lines.append(
                "- **before = mã HEAD**: chỉ là \"trước sửa\" nếu HEAD chưa chứa fix P16; "
                "nếu HEAD đã có fix thì before ≈ after, khi đó phải đo lại bằng commit cũ."
            )
        for key, path in (("before", BASELINE_BEFORE), ("after", BASELINE_AFTER)):
            exists = "có" if Path(path).is_file() else "KHÔNG có"
            lines.append(f"- baseline P16b đã lưu {key}: `{path}` ({exists})")
        for label, runs_key, agg_key in (
            ("before", "before_runs", "before_agg"),
            ("after", "after_runs", "after_agg"),
        ):
            runs = real.get(runs_key) or []
            if not runs:
                continue
            lines += ["", f"**{label}** — ENTRY/EXIT từng lần:"]
            for run in runs:
                totals = run.get("totals") or {}
                call = run.get("call") or {}
                if call.get("reused"):
                    origin = "đã lưu"
                else:
                    origin = f"rc={call.get('returncode')}, {call.get('seconds', 0):.0f} s"
                lines.append(
                    f"- lần {run['index']}: ENTRY {totals.get('entry')}, "
                    f"EXIT {totals.get('exit')} ({origin}) → `{run['path']}`"
                )
            agg = real.get(agg_key) or {}
            entry = agg.get("entry") or {}
            exit_ = agg.get("exit") or {}
            lines.append(
                f"- **TB / min:** ENTRY {entry.get('mean')} / {entry.get('min')} · "
                f"EXIT {exit_.get('mean')} / {exit_.get('min')} "
                f"({agg.get('ok_runs')}/{agg.get('runs')} lần đọc được)"
            )
        if real.get("call"):  # đường cũ: một lần chạy after
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
    lines = ["", "P16j — bảng nghiệm thu", header, "-" * len(header)]
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
        "--repeat-real",
        type=int,
        default=REAL_REPEAT_DEFAULT,
        metavar="N",
        help=(
            "số lần chạy real_baseline cho MỖI trạng thái mã (before=HEAD, after=worktree); "
            f"R4 chấm theo trung bình N lần (mặc định {REAL_REPEAT_DEFAULT})"
        ),
    )
    result.add_argument(
        "--reuse-before",
        nargs="+",
        metavar="PATH",
        default=None,
        help=(
            "dùng kết quả before ĐÃ LƯU thay vì chạy lại: thư mục (mọi "
            "baseline_before*.json), glob, hoặc danh sách file JSON. "
            "Thiếu/sai file thì dừng với lỗi rõ."
        ),
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
        "--repeat-real",
        str(args.repeat_real),
        "--out-dir",
        str(args.out_dir),
        "--runs-dir",
        str(args.runs_dir),
        "--min-free-gb",
        f"{args.min_free_gb:g}",
    ]
    if args.reuse_before:
        parts.append("--reuse-before")
        parts.extend(str(value) for value in args.reuse_before)
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
        "schema_version": 2,
        "tool": "sim3d/tools/p16_accept.py",
        "phase": "P16j",
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
                "entry_exit": "trung bình N lần: after ≥ before",
                "repeat_default": REAL_REPEAT_DEFAULT,
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
    if args.repeat_real < 1:
        print("--repeat-real phải ≥ 1 (mỗi trạng thái mã chạy ít nhất 1 lần)", file=sys.stderr)
        return 2
    if args.reuse_before and "real" not in scenarios:
        print(
            "--reuse-before chỉ dùng khi có phần real (đừng --skip-real)",
            file=sys.stderr,
        )
        return 2

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
    real_before_runs: list[RealRun] | None = None
    real_after_runs: list[RealRun] | None = None
    real_missing_note = ""
    if "real" in scenarios:
        repeat = args.repeat_real
        if args.reuse_before:
            try:
                real_before_runs = load_reuse_before(args.reuse_before)
            except ReuseBeforeError as error:
                print(f"\nDỪNG: {error}", file=sys.stderr)
                return 2
            print(
                f"\nDùng {len(real_before_runs)} kết quả before ĐÃ LƯU "
                "(không replay before):"
            )
            for run in real_before_runs:
                totals = real_run_totals(run.doc)
                print(
                    f"  before lần {run.index}: {run.path.name} — "
                    f"ENTRY {totals['entry']}, EXIT {totals['exit']}, "
                    f"new GID {totals['new_gid']}, merge {totals['merge']}"
                )
            print(
                f"\nChạy baseline video thật: after(worktree) × {repeat} "
                f"(cổng {REAL_API_PORT}/{REAL_GATE_PORT})…"
            )
        else:
            print(
                f"\nChạy baseline video thật: before(HEAD) × {repeat} + "
                f"after(worktree) × {repeat} (cổng {REAL_API_PORT}/{REAL_GATE_PORT})…"
            )
        try:
            if not args.reuse_before:
                real_before_runs = measure_real_state(
                    "before", repeat, out_dir, min_free_gb=args.min_free_gb
                )
            real_after_runs = measure_real_state(
                "after", repeat, out_dir, min_free_gb=args.min_free_gb
            )
        except InsufficientSpace as error:
            print(f"\nDỪNG: {error}", file=sys.stderr)
            return 3
        for label, state_runs in (("before", real_before_runs), ("after", real_after_runs)):
            for run in state_runs:
                totals = real_run_totals(run.doc)
                if (run.call or {}).get("reused"):
                    print(
                        f"  {label} lần {run.index}: ENTRY {totals['entry']}, "
                        f"EXIT {totals['exit']} (đã lưu)"
                    )
                    continue
                seconds = float((run.call or {}).get("seconds") or 0.0)
                print(
                    f"  {label} lần {run.index}: ENTRY {totals['entry']}, "
                    f"EXIT {totals['exit']} (rc={(run.call or {}).get('returncode')}, "
                    f"{seconds:.0f} s)"
                )
                if not run.ok:
                    notes.append(
                        f"real {label} lần {run.index}: không đọc được "
                        f"{run.path.name} — xem log"
                    )
            agg = aggregate_real_runs(state_runs)
            print(
                f"  {label}: ENTRY TB {agg['entry']['mean']} "
                f"(min {agg['entry']['min']}) · EXIT TB {agg['exit']['mean']} "
                f"(min {agg['exit']['min']})"
            )
        if not any(run.ok for run in real_before_runs) or not any(
            run.ok for run in real_after_runs
        ):
            real_missing_note = "thiếu kết quả real_baseline ở một trạng thái — chưa chấm R4"
            notes.append(real_missing_note)
        real_before_doc = next(
            (run.doc for run in reversed(real_before_runs) if run.ok), None
        )
        real_after_doc = next(
            (run.doc for run in reversed(real_after_runs) if run.ok), None
        )
        real = {
            "repeat": repeat,
            "before_runs": [run.to_dict() for run in real_before_runs],
            "after_runs": [run.to_dict() for run in real_after_runs],
            "before_agg": aggregate_real_runs(real_before_runs),
            "after_agg": aggregate_real_runs(real_after_runs),
            "before_doc": real_before_doc,
            "after_doc": real_after_doc,
        }

    rows = score_all(
        scenarios,
        sim_results=runs,
        real_before=real_before_doc,
        real_after=real_after_doc,
        real_missing_note=real_missing_note,
        real_before_runs=real_before_runs,
        real_after_runs=real_after_runs,
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

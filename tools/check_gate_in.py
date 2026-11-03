#!/usr/bin/env python
"""Kiểm ``gt_events.csv`` của một run: MỌI xe được thêm phải có ``gate_in_frame``.

Vì sao cần (TASK P10e mục 2, GATE_1 điều kiện đóng lại G1)
----------------------------------------------------------
Lỗi cũ của sim: xe bị xếp hàng ở trạng thái ``queued`` **không bao giờ vào bãi**, nên nó
không có ``gate_in_frame`` — nhưng test cũ bỏ qua ``queued`` nên G1 vẫn "đóng". Nay điều kiện
đóng G1 ghi rõ "mọi xe được thêm có ``gate_in``". Script này kiểm đúng điều đó trên **run đã
xuất** (nguồn sự thật cuối cùng), không phụ thuộc test của ``sim/``.

Quy ước (đọc từ ``sim/gtCompute.ts`` ``gtEvents``):
- Xe **đỗ sẵn** (``initial_parked = 1``): ``gate_in_frame`` **rỗng là đúng** — nó ở bãi từ
  frame 0, không đi qua cổng vào.
- Xe **được thêm trong kịch bản** (``initial_parked = 0``): **phải** có ``gate_in_frame``.

Chạy::

    python sim3d/tools/check_gate_in.py sim3d/data/runs/<run_id> [<run_id> ...]
    python sim3d/tools/check_gate_in.py --glob "sim3d/data/runs/2026*K2*"

Thoát mã 0 nếu mọi run đạt, 1 nếu có run lệch (R2: không im lặng).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Final

TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent

#: Cột bắt buộc trong ``gt_events.csv``.
REQUIRED_COLUMNS: Final = ("car", "slot", "gate_in_frame", "initial_parked")


class GateInError(Exception):
    """``gt_events.csv`` sai cấu trúc — không phải "xe thiếu gate_in"."""


def read_events(path: Path) -> list[dict[str, str]]:
    """Đọc ``gt_events.csv``; ném lỗi rõ nếu thiếu file/cột."""
    if not path.exists():
        raise GateInError(f"không thấy {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames or []
        missing = [name for name in REQUIRED_COLUMNS if name not in columns]
        if missing:
            raise GateInError(
                f"{path.name}: thiếu cột {', '.join(missing)} (có: {', '.join(columns)})"
            )
        return list(reader)


def check_run(run_dir: Path) -> dict[str, object]:
    """Kiểm một run. Trả dict tóm tắt + danh sách xe thiếu ``gate_in``."""
    events_path = run_dir / "gt_events.csv"
    rows = read_events(events_path)

    missing: list[dict[str, object]] = []
    added = 0
    parked_initially = 0
    for row in rows:
        car = (row.get("car") or "").strip()
        if car == "":
            raise GateInError(f"{events_path}: có dòng không mã xe")
        raw_initial = (row.get("initial_parked") or "0").strip() or "0"
        try:
            initial = int(raw_initial)
        except ValueError as error:
            raise GateInError(
                f"{events_path}: {car} có initial_parked={raw_initial!r} không phải số"
            ) from error
        gate_in = (row.get("gate_in_frame") or "").strip()
        if initial == 1:
            parked_initially += 1
            continue
        added += 1
        if gate_in == "":
            missing.append(
                {
                    "car": car,
                    "slot": (row.get("slot") or "").strip(),
                    "parked_frame": (row.get("parked_frame") or "").strip(),
                    "depart_frame": (row.get("depart_frame") or "").strip(),
                    "gate_out_frame": (row.get("gate_out_frame") or "").strip(),
                }
            )

    return {
        "run_id": run_dir.name,
        "events_rows": len(rows),
        "cars_added": added,
        "cars_initial_parked": parked_initially,
        "missing_gate_in": missing,
        "ok": len(missing) == 0,
    }


def read_verify(run_dir: Path) -> dict[str, object] | None:
    """Đọc ``verify.json`` nếu có (để in kèm cho dễ đối chiếu)."""
    path = run_dir / "verify.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise GateInError(f"{path.name} không phải JSON hợp lệ: {error}") from error
    return payload if isinstance(payload, dict) else None


def describe(run_dir: Path) -> str:
    """Một dòng tóm tắt cho REPORT."""
    result = check_run(run_dir)
    status = "ĐẠT" if result["ok"] else "LỆCH"
    line = (
        f"{status} {result['run_id']}: {result['cars_added']} xe thêm / "
        f"{result['cars_initial_parked']} đỗ sẵn"
    )
    if not result["ok"]:
        detail = ", ".join(
            f"{item['car']}({item['slot']})" for item in result["missing_gate_in"]  # type: ignore[union-attr]
        )
        line += f" — THIẾU gate_in: {detail}"
    return line


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Kiểm mọi xe được thêm trong run đều có gate_in_frame (điều kiện G1)"
    )
    parser.add_argument("run_dirs", nargs="*", type=Path, help="thư mục run")
    parser.add_argument(
        "--glob",
        default=None,
        help="mẫu glob tương đối từ sim3d/ (vd 'data/runs/2026*_K2-*')",
    )
    args = parser.parse_args(argv)

    targets: list[Path] = list(args.run_dirs)
    if args.glob is not None:
        targets.extend(sorted(p for p in SIM3D_DIR.glob(args.glob) if p.is_dir()))
    if not targets:
        parser.error("cần ít nhất một run (tham số hoặc --glob)")

    failed = 0
    for run_dir in targets:
        run_dir = run_dir.resolve()
        if not run_dir.is_dir():
            print(f"KHÔNG THẤY {run_dir}", file=sys.stderr)
            failed += 1
            continue
        try:
            result = check_run(run_dir)
            verify = read_verify(run_dir)
        except GateInError as error:
            # R2: nêu rõ run nào và vì sao, không chỉ tăng bộ đếm.
            print(f"LỖI {run_dir.name}: {error}", file=sys.stderr)
            failed += 1
            continue
        print(describe(run_dir))
        if verify is not None:
            print(
                f"    verify.ok={verify.get('ok')} · "
                f"realtime_ratio={verify.get('realtime_ratio')}"
            )
        if not result["ok"]:
            failed += 1
            for item in result["missing_gate_in"]:  # type: ignore[union-attr]
                print(
                    f"    thiếu gate_in: {item['car']} ô {item['slot']} "
                    f"(parked={item['parked_frame'] or '-'} depart={item['depart_frame'] or '-'})",
                    file=sys.stderr,
                )

    print(f"\n{len(targets) - failed}/{len(targets)} run đạt")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

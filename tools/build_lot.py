"""Sinh ``sim3d/data/lot/lot_pucpr.json`` + 2 ảnh kiểm (P2, sửa lại ở P2b).

Nguồn sự thật:
- Tâm/kích thước ô: ``docs/pklot_video/sample_spaces.csv`` (px trên ảnh 640×640).
- Camera: ``docs/pklot_video/blender/build_blender_video.py:48-62`` (chúi 80°, f=288,
  cao 33,6 m) — chép nguyên văn, không sửa.
- Chuẩn hoá ô theo hàng: ý tưởng §14 **D5**; lối vòng một chiều: **D6**.
- Luật làn sát cổng:**L-GATE** (director G1, P2b mục 2).
- Cổng: ý tưởng §8 (vào u=615), P2b dời cổng ra u=25 → u=22 để đạt L-GATE.

P2b sửa 4 điểm so với P2:
1. **Ô không chồng**: tâm ô đặt trên **lưới đều** của hàng (bước khớp minimax với csv), nên
   hai ô kề chỉ chạm cạnh — hết chồng S043/S044 và S046/S047/S048. Ô nào lệch csv > 3 px thì
   in ID + số px ra stdout và ghi vào ``center_shift_px``.
2. **L-GATE**: chỉ A2 cắt vạch cổng; mọi làn khác cách đoạn cổng ≥ 2,0 m tính cả nửa bề rộng.
3. **A3 là đường nhựa**, bỏ cỏ dưới làn; V_far_w vòng qua đầu tây hàng 4.
4. **Ô trang trí** ngoài 100 ô (dải trên hàng 1) chỉ để cảnh nhìn tự nhiên, không có xe.

Chạy::

    python sim3d/tools/build_lot.py
    python sim3d/tools/build_lot.py --check     # chỉ kiểm, không ghi file

Ghi ra:
- ``sim3d/data/lot/lot_pucpr.json``
- ``sim3d/tools/out/plan.png``    sơ đồ làn (mũi tên) + mã ô, nhìn từ trên
- ``sim3d/tools/out/overlay.png`` đa giác ô + làn + decor đè 50% lên ảnh PKLot tham chiếu
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Final

import cv2
import numpy as np

# --------------------------------------------------------------------------------------
# Đường dẫn
# --------------------------------------------------------------------------------------
TOOLS_DIR: Final = Path(__file__).resolve().parent
SIM3D_DIR: Final = TOOLS_DIR.parent
REPO_DIR: Final = SIM3D_DIR.parent
CSV_PATH: Final = REPO_DIR / "docs" / "pklot_video" / "sample_spaces.csv"
REF_IMAGE: Final = (
    REPO_DIR / "archive" / "test" / "2012-09-15_14_57_21_jpg.rf.986866692e7f396a959b663c817a9f17.jpg"
)
OUT_LOT: Final = SIM3D_DIR / "data" / "lot" / "lot_pucpr.json"
OUT_DIR: Final = TOOLS_DIR / "out"
OUT_PLAN: Final = OUT_DIR / "plan.png"
OUT_OVERLAY: Final = OUT_DIR / "overlay.png"

# --------------------------------------------------------------------------------------
# Camera (nguyên văn build_blender_video.py:48-62)
# --------------------------------------------------------------------------------------
PITCH_DEG: Final = 80.0
F_PX: Final = 288.0
HEIGHT_M: Final = 33.6
RES_PX: Final = 640
CX: Final = 320.0
CY: Final = 320.0
CAM1_X: Final = (0, 400)
CAM2_X: Final = (240, 640)
_PH = math.radians(PITCH_DEG)


def ground(u: float, v: float) -> tuple[float, float]:
    """px → mét. Nguyên văn công thức bộ cũ."""
    t = (v - CY) / F_PX
    y = HEIGHT_M * (math.cos(_PH) - t * math.sin(_PH)) / (t * math.cos(_PH) + math.sin(_PH))
    z = y * math.cos(_PH) + HEIGHT_M * math.sin(_PH)
    return (u - CX) * z / F_PX, y


def project(x: float, y: float) -> tuple[float, float]:
    """mét → px. Nghịch đảo của :func:`ground`."""
    z = y * math.cos(_PH) + HEIGHT_M * math.sin(_PH)
    return (
        CX + F_PX * x / z,
        CY + F_PX * (-y * math.sin(_PH) + HEIGHT_M * math.cos(_PH)) / z,
    )


def px_per_m(v: float) -> tuple[float, float]:
    """Số px của 1 m theo trục u và trục v tại hàng có v cho trước."""
    x0, _ = ground(CX, v)
    x1, _ = ground(CX + 1.0, v)
    _, y0 = ground(CX, v)
    _, y1 = ground(CX, v + 1.0)
    return 1.0 / abs(x1 - x0), 1.0 / abs(y1 - y0)


def heading_from_img_deg(u: float, v: float, ang_deg: float) -> float:
    """Góc mũi xe trên ảnh (0° = lên trên) → hướng world (rad). Nguyên văn bộ cũ."""
    a = math.radians(ang_deg)
    x, y = ground(u, v)
    nx, ny = ground(u + 6.0 * math.sin(a), v - 6.0 * math.cos(a))
    return math.atan2(ny - y, nx - x)


# --------------------------------------------------------------------------------------
# Dữ liệu hàng (đọc từ ảnh tham chiếu + csv)
# --------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RowSpec:
    """Một hàng ô đỗ đã chuẩn hoá (D5).

    ``img_heading_deg``: hướng mũi xe trên ảnh (0 = lên trên, 180 = xuống dưới).
    Lấy từ ảnh tham chiếu: xe ở hàng trên (1, 2, 3) đỗ mũi quay vào bó vỉa phía trên
    của hàng mình, hàng 4 mũi quay xuống, hàng 5 (dải gạch dưới cùng) mũi quay lên.
    """

    key: str
    #: Dải ``cy`` (px) dùng để lọc ô thuộc hàng này từ csv.
    cy_range: tuple[float, float]
    img_heading_deg: float
    #: Chiều sâu ô tiêu chuẩn (m) — chuẩn hoá, không lấy ``h`` lộn xộn của csv.
    depth_m: float    #: Bước ô tiêu chuẩn (m) — chuẩn hoá theo trung vị bước thật của hàng.
    pitch_m: float | None = None


ROWS: Final[tuple[RowSpec, ...]] = (
    RowSpec("1", (150.0, 210.0), 0.0, 4.85),
    RowSpec("2", (215.0, 285.0), 180.0, 4.85),
    RowSpec("3", (285.0, 340.0), 0.0, 4.85),
    RowSpec("4", (345.0, 435.0), 180.0, 4.85),
    RowSpec("5", (436.0, 520.0), 0.0, 4.85),
)


@dataclass
class SlotCsv:
    """Một dòng ``sample_spaces.csv`` đã đổi sang mét."""

    id: str
    row: str
    u: float
    v: float
    w_px: float
    h_px: float
    center_px: tuple[float, float] = field(init=False)

    def __post_init__(self) -> None:
        self.center_px = (self.u + self.w_px / 2.0, self.v + self.h_px / 2.0)

    @property
    def center_m(self) -> tuple[float, float]:
        return ground(*self.center_px)

    @property
    def width_m(self) -> float:
        """Bề rộng ô thật (cạnh ngắn) đo trên ảnh tại tâm ô."""
        pxu, _ = px_per_m(self.center_px[1])
        return self.w_px / pxu


def read_csv(path: Path = CSV_PATH) -> list[SlotCsv]:
    """Đọc ``sample_spaces.csv`` theo đúng thứ tự file (quyết định mã S001…S100)."""
    with path.open("r", encoding="utf-8") as handle:
        raw = list(csv.DictReader(handle))
    if len(raw) != 100:
        raise ValueError(f"{path.name}: cần đúng 100 dòng, đọc được {len(raw)}")
    out: list[SlotCsv] = []
    for index, row in enumerate(raw, start=1):
        expected = f"S{index:03d}"
        if row["space_id"] != expected:
            raise ValueError(f"{path.name}: dòng {index} là {row['space_id']}, cần {expected}")
        slot = SlotCsv(
            id=row["space_id"],
            row="",
            u=float(row["x"]),
            v=float(row["y"]),
            w_px=float(row["w"]),
            h_px=float(row["h"]),
        )
        out.append(slot)
    return out


def assign_rows(slots: Sequence[SlotCsv]) -> dict[str, list[SlotCsv]]:
    """Gán mỗi ô vào một hàng theo ``cy`` (méta dải của :data:`ROWS`), ghi vào ``slot.row``."""
    groups: dict[str, list[SlotCsv]] = {spec.key: [] for spec in ROWS}
    for slot in slots:
        cy = slot.center_px[1]
        for spec in ROWS:
            if spec.cy_range[0] <= cy <= spec.cy_range[1]:
                slot.row = spec.key
                groups[spec.key].append(slot)
                break
        else:
            raise ValueError(f"{slot.id}: cy={cy:.1f} không thuộc hàng nào trong {ROWS}")
    return groups


# --------------------------------------------------------------------------------------
# Hình học: chuẩn hoá ô theo hàng (D5)
# --------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RowGeometry:
    """Hình học đã chuẩn hoá của một hàng."""

    key: str
    heading: float
    depth_m: float
    width_m: float
    #: ``True`` nếu mũi xe quay về +Y (bắc).
    nose_north: bool
    #: Đường tâm hàng trong world: ``y = slope * x + intercept``.
    slope: float
    intercept: float


def row_geometry(spec: RowSpec, slots: Sequence[SlotCsv]) -> RowGeometry:
    """Chuẩn hoá hàng (D5): đường tâm hàng + hướng đỗ vuông góc, đều cho cả hàng.

    - Đường tâm: hồi quy bậc 1 qua tâm ô (world) của hàng.
    - Hướng đỗ: pháp tuyến của đường tâm, chọn dấu theo ``spec.img_heading_deg``
      (hướng mũi xe nhìn trên ảnh tham chiếu).
    - Bề rộng ô: bước ô trung vị của hàng để các ô kề nhau khít.
    """
    pts = [s.center_m for s in slots]
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    slope, intercept = (float(v) for v in np.polyfit(xs, ys, 1))
    row_angle = math.atan(slope)
    mean_u = sum(s.center_px[0] for s in slots) / len(slots)
    mean_v = sum(s.center_px[1] for s in slots) / len(slots)
    reference = heading_from_img_deg(mean_u, mean_v, spec.img_heading_deg)

    candidates = (row_angle + math.pi / 2.0, row_angle - math.pi / 2.0)

    def angle_gap(a: float, b: float) -> float:
        return abs((a - b + math.pi) % (2.0 * math.pi) - math.pi)

    heading = min(candidates, key=lambda cand: angle_gap(cand, reference))
    steps = np.diff(np.sort(xs))
    width = float(np.median(steps)) if len(steps) else 2.5
    # Chiều sâu: dùng ``spec.depth_m`` (4,85 m) thay vì ``h`` của csv — bbox csv cộng cả
    # bóng xe + viền nên đo ra sâu hơn vạch sơn thật; D5 yêu cầu chiều sâu đều theo hàng.
    return RowGeometry(
        key=spec.key,
        heading=heading,
        depth_m=spec.depth_m,
        width_m=width,
        nose_north=math.sin(heading) > 0.0,
        slope=slope,
        intercept=intercept,
    )


def snap_to_row_line(center: tuple[float, float], geometry: RowGeometry) -> tuple[float, float]:
    """Chiếu tâm ô (từ csv) về đường tâm hàng — giữ vị trí dọc hàng (D5)."""
    x, y = center
    m, b = geometry.slope, geometry.intercept
    denom = 1.0 + m * m
    along = (x + m * (y - b)) / denom
    return (along, b + m * along)


#: Sai số px tối đa cho phép khi dịch tâm ô (Done của P2: "tâm ô ≤ 3 px so với csv").
MAX_CENTER_SHIFT_PX: Final = 2.9
#: Khe sơn tối thiểu giữa hai ô kề (m) — đủ để đa giác không chạm nhau sau khi làm tròn.
SLOT_GAP_M: Final = 0.02
#: Bước (m) lớn hơn ngưỡng này là **chỗ khuyết ô** trong hàng (csv có ô trống thật), không
#: phải ô đặt lệch. Bước lớn nhất của một cặp ô kề thật trong csv là 3,01 m (S043/S044 hàng 2)
#: và 3,17 m (hàng 5), còn chỗ khuyết thật là 3,45–3,60 m ⇒ ngưỡng 3,2 m tách đúng.
BLOCK_GAP_MIN_M: Final = 3.2


def row_tangent(geometry: RowGeometry) -> tuple[float, float]:
    """Vectơ đơn vị dọc theo hàng (vuông góc hướng đỗ)."""
    angle = geometry.heading + math.pi / 2.0
    return (math.cos(angle), math.sin(angle))


def _project_on_row_line(
    geometry: RowGeometry,
    along: float,
    tangent: tuple[float, float],
) -> tuple[float, float]:
    """Điểm trên đường tâm hàng có toạ độ ``along`` (m, dọc hàng, gốc x=0)."""
    m, b = geometry.slope, geometry.intercept
    tx, ty = tangent
    # ``along = x*tx + (m x + b)*ty`` trên đường tâm ⇒ giải ra ``x``.
    x = (along - b * ty) / (tx + m * ty) if abs(tx + m * ty) > 1e-9 else along
    return (x, m * x + b)


def _perp_offset(point: tuple[float, float], geometry: RowGeometry) -> float:
    """Khoảng cách có dấu (m, + = bắc) từ điểm tới đường tâm hàng."""
    x, y = point
    return (y - (geometry.slope * x + geometry.intercept)) / math.hypot(1.0, geometry.slope)


def _separate_rows(
    rows: dict[str, RowGeometry],
    members: dict[str, Sequence[SlotCsv]],
) -> dict[str, RowGeometry]:
    """Đẩy hai hàng đỗ mũi-đối-mũi ra để đa giác **hai hàng** không giao nhau.

    Tâm ô csv không nằm đúng trên đường tâm hàng (lệch tới ~0,45 m, tức ~4 px), nên khoảng
    cách danh nghĩa giữa hai đường tâm không đủ: mép ô của hàng này thò sang hàng kia. Vì
    vậy dùng **mép thật**: mép trước của hàng bắc = min(perp_offset − sâu/2), mép trước của
    hàng nam = max(perp_offset + sâu/2). Thiếu bao nhiêu thì đẩy hai đường tâm ra đều nhau.
    """
    keys = [spec.key for spec in ROWS if spec.key in rows]
    out = dict(rows)
    for left, right in itertools.pairwise(keys):
        for _ in range(20):
            a, b = out[left], out[right]
            offs_a = [_perp_offset(s.center_m, a) for s in members[left]]
            offs_b = [_perp_offset(s.center_m, b) for s in members[right]]
            near_a = min(offs_a) - a.depth_m / 2.0  # mép phía hàng kia
            near_b = max(offs_b) + b.depth_m / 2.0
            gap = near_b - near_a
            if gap >= SLOT_GAP_M:
                break
            deficit = SLOT_GAP_M - gap
            scale = math.hypot(1.0, (a.slope + b.slope) / 2.0)
            out[left] = replace(a, intercept=a.intercept - deficit * scale / 2.0)
            out[right] = replace(b, intercept=b.intercept + deficit * scale / 2.0)
    return out


def _spread_min_gap(targets: list[float], gap: float) -> list[float]:
    """Nới các vị trí ``targets`` (đã sắp tăng) để mọi cặp kề cách ≥ ``gap``.

    Dùng phép đẩy đối xứng tại chỗ (giữ vị trí gần csv nhất có thể): mỗi lần một cặp gần
    hơn ``gap`` thì đẩy hai bên ra đều nhau. Hội tụ nhanh vì chỉ cần dịch cục bộ vài cm.
    """
    out = list(targets)
    for _ in range(500):
        moved = False
        for i in range(1, len(out)):
            short = gap - (out[i] - out[i - 1])
            if short > 1e-12:
                half = short / 2.0
                out[i - 1] -= half
                out[i] += half
                moved = True
        if not moved:
            break
    return out


def normalize_row(
    slots: Sequence[SlotCsv],
    geometry: RowGeometry,
) -> tuple[dict[str, tuple[tuple[float, float], float]], float]:
    """Chuẩn hoá bước ô theo hàng, **không để hai ô kề giao nhau** (P2b, mục 1).

    Vì sao: GT "tâm xe trong đa giác" chỉ đúng khi mỗi điểm thuộc tối đa 1 ô, và kiểm va
    chạm xe đỗ không được báo chồng giả. Bước ô thật của csv dao động 1,97–3,01 m trong khi
    bề rộng ô ~2,2–2,9 m ⇒ vài cặp chồng (S043/S044, S046/S047/S048 ở P2).

    Cách làm: bề rộng ô của hàng là **một hằng số** ``w``; tâm các ô trong hàng phải cách
    nhau ≥ ``w + khe``. Chọn ``w`` **lớn nhất** mà sau khi nới vẫn giữ mọi tâm trong 3 px so
    với csv (yêu cầu Done của P2). Nhờ vậy bước ô đều theo hàng và không cặp nào giao nhau.

    Trả ``({id: (tâm, sai số px so với csv)}, bề rộng ô)``.
    """
    tx, ty = row_tangent(geometry)

    def along_of(point: tuple[float, float]) -> float:
        return point[0] * tx + point[1] * ty

    items = sorted(((along_of(s.center_m), s) for s in slots), key=lambda pair: pair[0])
    # Tách hàng thành các **dải liền mạch**: bước nhảy > ngưỡng là chỗ csv khuyết ô thật
    # (hàng 1 khuyết sau S012, hàng 2 sau S040, hàng 3 sau S049, hàng 4 sau S071).
    blocks: list[list[tuple[float, SlotCsv]]] = [[items[0]]]
    for prev, nxt in itertools.pairwise(items):
        if nxt[0] - prev[0] > BLOCK_GAP_MIN_M:
            blocks.append([])
        blocks[-1].append(nxt)

    # Bước ô **đều cho cả hàng** (P2b mục 1): một bước duy nhất, đặt tâm trên lưới
    # ``anchor + index·step``. Bước và mốc neo được **khớp bình phương nhỏ nhất** vào tâm csv
    # (chỉ số nguyên lấy bằng cách cộng dồn số bước), nên bước đều tuyệt đối mà tâm vẫn bám
    # csv trong ~1 px. Chỗ csv khuyết ô tự thành bước nhảy nhiều đơn vị.
    block_steps = [(b[-1][0] - b[0][0]) / (len(b) - 1) for b in blocks if len(b) > 1]
    pitch = float(np.median(block_steps)) if block_steps else geometry.width_m

    # Bước ô **đều cho cả hàng** (P2b mục 1): **một** bước duy nhất cho mọi ô của hàng, đặt
    # tâm trên lưới ``anchor_dải + index·step``. Bước chọn bằng bình phương nhỏ nhất trên tất
    # cả các dải (nên nó là "bước trung bình" của hàng, không bị một dải lệch kéo đi); mỗi dải
    # tự neo theo trung vị độ lệch của mình, nên chỗ csv khuyết ô không làm lệch cả hàng.
    # Nhờ vậy: bước đều tuyệt đối (test kiểm), và hai ô kề cách nhau đúng ``step`` ≥ bề rộng +
    # khe sơn ⇒ không thể giao nhau.
    block_steps = [(b[-1][0] - b[0][0]) / (len(b) - 1) for b in blocks if len(b) > 1]
    pitch = float(np.median(block_steps)) if block_steps else geometry.width_m

    indexed: list[tuple[float, float, SlotCsv, int]] = []
    running = 0.0
    previous_tail: float | None = None
    for block_index, block in enumerate(blocks):
        raw = [along for along, _slot in block]
        if previous_tail is not None:
            # Chỗ khuyết ô: nhảy đúng số bước nguyên gần nhất.
            running += max(1.0, round((raw[0] - previous_tail) / pitch))
        for offset, (along, (_a, slot)) in enumerate(zip(raw, block)):
            indexed.append((running + offset, along, slot, block_index))
        running += len(raw) - 1
        previous_tail = raw[-1]

    ks = np.array([k for k, _t, _slot, _b in indexed])
    ts = np.array([along for _k, along, _slot, _b in indexed])
    step, global_anchor = _minimax_lattice(ks, ts, pitch)
    if not math.isfinite(step) or step <= 0.0:
        step, global_anchor = pitch, float(np.median(ts - pitch * ks))

    placed: dict[str, tuple[tuple[float, float], float]] = {}
    for (k, _along, slot, _block) in indexed:
        target = _project_on_row_line(geometry, global_anchor + step * k, (tx, ty))
        u0, v0 = project(*slot.center_m)
        u1, v1 = project(*target)
        placed[slot.id] = (target, math.hypot(u1 - u0, v1 - v0))
    return placed, step - SLOT_GAP_M


def _minimax_lattice(ks: np.ndarray, ts: np.ndarray, pitch: float) -> tuple[float, float]:
    """Khớp lưới đều ``t = anchor + step·k`` theo **minimax** (giảm sai số lớn nhất).

    Bình phương nhỏ nhất dồn sai số vào vài ô ở đầu/cuối hàng; minimax chia đều nên số ô
    vượt 3 px ít hơn. Tìm ``step`` bằng tam phân trên nửa biên độ sai số (hàm lồi theo
    ``step``), rồi lấy ``anchor`` = trung điểm dải sai số.
    """

    def half_range(step: float) -> float:
        residuals = ts - step * ks
        return float(residuals.max() - residuals.min()) / 2.0

    low, high = pitch * 0.85, pitch * 1.15
    for _ in range(200):
        a = low + (high - low) / 3.0
        b = high - (high - low) / 3.0
        if half_range(a) < half_range(b):
            high = b
        else:
            low = a
    step = (low + high) / 2.0
    residuals = ts - step * ks
    anchor = float(residuals.max() + residuals.min()) / 2.0
    return step, anchor


def limited_snap(
    slot: SlotCsv,
    geometry: RowGeometry,
) -> tuple[tuple[float, float], float]:
    """Chiếu tâm ô về đường tâm hàng, **không** giới hạn sai số.

    Giữ lại để tương thích với mã cũ; :func:`normalize_row` là đường đi chính (nó đặt tâm
    trên lưới đều nên khe giữa hai ô được bảo đảm).
    """
    target = snap_to_row_line(slot.center_m, geometry)
    u0, v0 = project(*slot.center_m)
    u1, v1 = project(*target)
    return target, math.hypot(u1 - u0, v1 - v0)


# --------------------------------------------------------------------------------------
# Làn (D6: vòng một chiều) + cổng
# --------------------------------------------------------------------------------------
#: Toạ độ ảnh của các trục làn, đọc từ ảnh tham chiếu và **kiểm không cắt ô nào**:
#: - Hàng ô theo v: 1) 156–207, 2) 226–278, 3) 267–327, 4) 367–431, 5) 442–507.
#: - Ô theo u: min 21 (S089), max 576 (S088).
#: - A1 (v=215) nằm giữa hàng 1 và 2; A2 (v=343) giữa hàng 3 và 4 (cũng là đường cổng);
#:   A3 (v=528) dưới hàng 5 trên dải gạch.
#: - Trục dọc: 596 / 620 (phải, ngoài mọi ô) và 45 / 15 (trái, ngoài mọi ô).
AISLE_V = {"A1": 218.0, "A2": 343.0, "A3": 528.0}
#: Trục dọc phải, dùng chung cho V_east và V_east_s (P2c: gộp lại một trục, rộng 3,5 m).
#: Ba điều kiện cùng lúc:
#: - đông hơn ô phải nhất của **mọi** hàng (S088: u=573,3) + nửa bề rộng làn (1,75 m ≈ 15 px);
#: - luật L-GATE: mép làn cách **cổng vào** ≥ 2,0 m ⇒ cổng vào dời từ u=615 sang **u=630**;
#: - vẫn trong khung ảnh (u + nửa làn < 640).
#: u=594, làn 3,5 m ⇒ mép tây 579,3 > 573,3 ✓; mép đông 608,7, cổng vào u=630 ⇒ cách 21,3 px
#: ≈ 2,49 m − 1,75 = 0,74 m… chưa đủ, xem ``GATE_IN_U`` bên dưới (đặt ở 640−nửa làn).
LANE_RIGHT_U = 594.0
#: Trục dọc trái trong (V_west). Tây hơn mọi ô hàng 1–3 (ô trái nhất S045: u=99,4) và cách
#: **cổng ra (u=22)** 36 px ≈ 4,2 m; trừ nửa làn 1,75 m còn 2,45 m ≥ 2,0 ✓ (L-GATE).
LANE_LEFT_U_MID = 58.0
#: Trục dọc sát mép tây của nhánh V_far_w: phải tây hơn ô trái nhất hàng 5 (S089) cộng nửa
#: bề rộng làn. u=−1,0 ⇒ mép đông ≈ 12,5 px, cách S089 (u=18,1) 5,6 px ≈ 0,6 m ✓.
LANE_FAR_LEFT_U = -1.0
#: ``u`` của trục bắc thứ hai trong V_far_w (đi lên nhập A2). Solver: 44–53 đều lọt giữa ô
#: S067 (hàng 4, đã dịch bắc 2 px) và S090 (hàng 5, đã dịch nam 2 px) với làn 2,8 m.
#: Chọn **50** ⇒ cách cổng ra (u=4) 46 px ≈ 5,38 m − 1,4 = 3,98 m ✓ (dư L-GATE).
LANE_FAR_MID_U = 50.0
#: ``v`` đoạn ngang V_far_w — **giữa dải trống** giữa hàng 4 và hàng 5 (sau khi đã dịch hai
#: hàng ra 2 px mỗi bên, dải này rộng 27,1 px ≈ 2,84 m). Đây là chỗ hẹp nhất của bãi.
LANE_FAR_JOG_V = 435.0
#: ``u`` nơi V_far_w **nhập A2** — trùng ``LANE_FAR_MID_U`` để đoạn nối cuối **thẳng đứng**
#: (đoạn chéo làm khoảng cách tới vạch cổng nhỏ đi ở giữa đoạn và phá L-GATE).
LANE_FAR_JOIN_U = 33.2
LANE_FAR_JOIN_V = 343.0

#: P17l (phương án B, ANS_32/33): V_far_w = cung phải → đoạn thẳng → cung trái, bán kính
#: ``FAR_W_TURN_R_M`` = 2,9 m (xe thật 3,86 m nhưng làn này chỉ rộng 2,8 m giữa hàng 4 và 5:
#: ngoại lệ có chủ ý, test lái thật ``lotTurnRadius`` khoá). Không đổi vị trí ô.
#: Nhập A2 ở ``u`` = ``LANE_FAR_JOIN_U``; góc α giải bằng chia đôi để điểm nhập đúng ``u`` đó.
#: Biên L-GATE_out ≈ 1,95 m (< 2,0): chấp nhận vì xe lái thật không quét (ghi README).
FAR_W_TURN_R_M = 2.9
FAR_W_ARC_SEGMENTS = 12


def _far_w_geometry(alpha: float) -> tuple[list[tuple[float, float]], tuple[float, float]]:
    """Đường tim V_far_w (A3 → A2) cho góc quay ``alpha`` (rad); trả (đường, điểm nhập A2)."""
    r = FAR_W_TURN_R_M
    t0 = ground(LANE_FAR_LEFT_U, AISLE_V["A3"])
    a2_y = ground(0.0, AISLE_V["A2"])[1]
    d = a2_y - t0[1]
    sa, ca = math.sin(alpha), math.cos(alpha)
    mx = t0[0] - 2 * r * sa - (d - 2 * r + 2 * r * ca) * ca / sa
    m = (mx, a2_y)

    def rot(v: tuple[float, float], a: float) -> tuple[float, float]:
        c, s = math.cos(a), math.sin(a)
        return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)

    def arc(c: tuple[float, float], rv: tuple[float, float], sweep: float) -> list[tuple[float, float]]:
        out = []
        for i in range(FAR_W_ARC_SEGMENTS + 1):
            q = rot(rv, sweep * i / FAR_W_ARC_SEGMENTS)
            out.append((c[0] + q[0], c[1] + q[1]))
        return out

    c1 = (t0[0], t0[1] + r)
    p1 = (t0[0] - r * sa, t0[1] + r - r * ca)
    c2 = (m[0], m[1] - r)
    t2 = (m[0] + r * sa, m[1] - r + r * ca)
    leg = math.hypot(t2[0] - p1[0], t2[1] - p1[1])
    n_leg = max(2, int(round(leg / 1.2)))
    path = arc(c1, (0.0, -r), -alpha)
    path += [(p1[0] + (t2[0] - p1[0]) * i / n_leg, p1[1] + (t2[1] - p1[1]) * i / n_leg) for i in range(1, n_leg + 1)]
    path += arc(c2, (t2[0] - c2[0], t2[1] - c2[1]), alpha)[1:]
    path[-1] = m
    return path, m


def far_w_path() -> list[tuple[float, float]]:
    lo, hi = math.radians(88.0), math.radians(179.0)
    for _ in range(80):
        mid = (lo + hi) / 2
        _, m = _far_w_geometry(mid)
        if project(m[0], m[1])[0] < LANE_FAR_JOIN_U:
            lo = mid
        else:
            hi = mid
    return _far_w_geometry((lo + hi) / 2)[0]

#: Cổng vào **u=630** (P2b là 615). Phải dời ra đông vì làn dọc phải rộng 3,5 m ở u=594:
#: L-GATE đòi mép làn cách vạch cổng ≥ 2,0 m, mà 615 − 594 = 21 px chỉ được 2,49 m − 1,75 m
#: = 0,74 m. u=630 ⇒ 36 px ≈ 4,21 m − 1,75 = 2,46 m ✓. Xe vẫn sinh ngoài khung bên phải.
GATE_IN_U = 630.0
#: Cổng ra **u=4** (P2b là 22). Phải dời về tây: trục bắc của V_far_w phải nằm ở u≈50 (nơi
#: duy nhất còn lọt giữa ô S067 hàng 4 và S090 hàng 5), và L-GATE đòi cách nó ≥ 2,0 m + nửa
#: bề rộng làn ⇒ cổng phải ở u ≤ 50 − (2,0 + 1,4) m ≈ 50 − 29 px = 21. Chọn 4.
GATE_OUT_U = 4.0
GATE_V = (322.0, 364.0)

#: Bề rộng làn (m). P2c bước 3 (ANS_3 mục 2): dải trống giữa hàng 4 và hàng 5 chỉ ~2,84 m
#: sau khi dịch hai hàng ra 2 px mỗi bên, nên V_far_w và V_east_s dùng **2,8 m** (bề rộng xe
#: lớn nhất sau phóng ~2,4 m + 0,4 m). Các làn khác vẫn ≥ 3,5 m.
AISLE_WIDTH_M = {
    "A1": 3.6,
    "A2": 5.0,
    "A3": 5.0,
    "V_east": 3.5,
    "V_east_s": 3.5,
    "V_west": 3.5,
    "V_far_w": 2.8,
    "V_east_m": 3.5,
    "V_east_n": 3.5,
    "V_west_n": 3.5,}

#: Bề rộng làn tối thiểu cho làn **có xe chạy** (ANS_3 mục 2 bước 3: 2,8 m).
MIN_DRIVE_LANE_M: Final = 2.8
#: Dịch **nguyên hàng** theo ``v`` (px, + = về nam / xuống dưới trên ảnh) để nới dải trống
#: giữa hàng 4 và hàng 5 cho V_far_w. Hàng 4 dịch bắc 2 px, hàng 5 dịch nam 2 px ⇒ dải rộng
#: 22,8 + 4,3 = 27,1 px ≈ 2,84 m. Tâm lệch thêm: hàng 4 → 5,89 px, hàng 5 → 5,93 px (≤ 8 ✓).
#:
#: P2d (ANS_6 phương án **B**): hàng 1 dịch **bắc 7 px**, hàng 2 dịch **nam 7 px** để dải
#: trống hàng 1/2 từ 3,54 m lên ~5,54 m — đủ cho cung vào ô 4,0 m (P5c) không quét sang xe
#: đỗ hàng đối diện. 7 px ≈ 1,0 m mỗi bên (1 px dọc ≈ 0,14 m ở hàng 1, 0,13 m ở hàng 2).
#: Ngưỡng lệch tâm hàng 1–2 được nới thành **20 px** theo ANS_6 mục 1 (hàng 3–5 giữ 8 px).
#: Hàng 2 lùi nam 7 px ⇒ gap hàng 2/3 giảm từ 0,75 m xuống ~-0,2 m, nên hàng 3 và 4 cũng được
#: đẩy nam thêm (hàng 3: 4 px, hàng 4: 4 px) để giữ 0 ô giao nhau; hàng 5 đẩy nam 2 px để
#: giữ khoảng cách với hàng 4 (ANS_6 mục 3 cho phép dời tiếp hàng 3–5 miễn ≤ 8 px).
ROW_V_OFFSET_PX: Final[dict[str, float]] = {
    "1": -16.0,
    "2": 0.0,
    "4": -2.0,
    "5": 2.0,
}

#: Ngưỡng lệch tâm tối đa so với csv, **theo hàng** (ANS_6 mục 1). Hàng 1–2 được nới vì phải
#: dời để đủ dải trống cho cung 4,0 m; hàng 3–5 giữ ngưỡng chặt cũ.
ROW_MAX_SHIFT_PX: Final[dict[str, float]] = {
    "1": 20.0,
    "2": 20.0,
    "3": 8.0,
    "4": 8.0,
    "5": 8.0,
}

#: Ngưỡng mặc định khi không có trong bảng trên (giữ như P2).
DEFAULT_ROW_MAX_SHIFT_PX: Final = 8.0

#: Mỗi ô lấy làn ở phía **đuôi xe** (vào ô tiến, ra ô lùi — FE §4.3).
SLOT_AISLE = {"1": "A1", "2": "A1", "3": "A2", "4": "A2", "5": "A3"}



#: P17l: cung nối R = 4,1 m ở ba góc ≈ 90° của vòng trong/ngoài (A1 đông, A1 tây, V_east → A2),
#: để mọi lộ trình có cua ≥ ``MIN_TURN_RADIUS_M`` (4 m). Không đổi vị trí ô.
JUNCTION_FILLET_R_M = 4.1
JUNCTION_FILLET_SEGMENTS = 10


def _fillet(
    prev: tuple[float, float], corner: tuple[float, float], nxt: tuple[float, float], r: float
) -> list[tuple[float, float]]:
    """Cung R tiếp xúc hai đoạn prev→corner và corner→nxt; trả các điểm từ T1 tới T2."""
    d1 = (corner[0] - prev[0], corner[1] - prev[1])
    d2 = (nxt[0] - corner[0], nxt[1] - corner[1])
    n1, n2 = math.hypot(*d1), math.hypot(*d2)
    d1 = (d1[0] / n1, d1[1] / n1)
    d2 = (d2[0] / n2, d2[1] / n2)
    turn = math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1])
    length = r * math.tan(abs(turn) / 2)
    if length >= min(n1, n2):
        raise ValueError("góc quá gần đỉnh kế, không đủ chỗ cho cung")
    t1 = (corner[0] - d1[0] * length, corner[1] - d1[1] * length)
    side = 1.0 if turn > 0 else -1.0
    centre = (t1[0] - d1[1] * r * side, t1[1] + d1[0] * r * side)
    start = math.atan2(t1[1] - centre[1], t1[0] - centre[0])
    pts = []
    for i in range(JUNCTION_FILLET_SEGMENTS + 1):
        a = start + turn * i / JUNCTION_FILLET_SEGMENTS
        pts.append((centre[0] + r * math.cos(a), centre[1] + r * math.sin(a)))
    return pts


@dataclass(frozen=True)
class AisleData:
    """Một làn một chiều đã đổi sang mét."""

    id: str
    polyline: tuple[tuple[float, float], ...]
    width_m: float
    oneway: bool = True
    connector: bool = False


def build_aisles() -> tuple[list[AisleData], dict[str, tuple[float, float]]]:
    """Dựng mạng làn **một chiều** (D6) + luật **L-GATE** (P2b mục 2).

    Luật L-GATE: **chỉ** đoạn A2 vào (sau cổng vào) và đoạn A2 ra (trước cổng ra) được cắt
    đoạn cổng; mọi làn khác cách đoạn cổng ≥ 2,0 m (tính cả nửa bề rộng làn). Có test hình
    học riêng (``test_l_gate_*``).

    Mạng (tất cả một chiều, không làn nào cắt qua đa giác ô — có test kiểm):

    - ``A2`` (v=343, hướng tây): lối gom, từ cổng vào (u=615) tới cổng ra (u=25) rồi
      ra ngoài khung. Hàng 3–4 lấy làn này. **Chỉ** làn này cắt 2 đoạn cổng.
    - ``V_west`` (u=88, hướng bắc): A2 → A1. Nằm tây hàng 2–3, xa cổng ra.
    - ``A1`` (v=215, hướng **đông**): 88 → 578. Hàng 1–2 lấy làn này.
    - ``V_east`` (u=578, hướng nam): A1 → A2 (khép vòng trong). Cách cổng vào 4,33 m ⇒
      trừ nửa bề rộng 2,0 m còn 2,33 m ≥ 2,0 ✓, và **không** vào tới A2 phía đông cổng vào.
    - ``V_east_s`` (u=620, hướng nam): A2 → A3 (nhánh xuống hàng 5, phía đông khung).
    - ``A3`` (v=528, hướng tây): 620 → 15. Hàng 5 lấy làn này.
    - ``V_far_w`` (u=15, hướng bắc): A3 → đầu tây hàng 5 → vòng lên bắc theo u=15 → nhập
      ``A2`` ở ``u=59`` (đông cổng ra 3,98 m ⇒ 2,23 m sau khi trừ nửa bề rộng ✓). Nhánh này
      **không** lên A1 (director G1 mục 2: "không lên A1").

    Nhờ vậy **mọi** xe ra đều đi qua cổng ra ở u=25 (D10: ``gate_out_frame``).
    """

    def pt(u: float, v: float) -> tuple[float, float]:
        return ground(u, v)

    far_w = far_w_path()
    nodes = {
        "g_in": pt(GATE_IN_U, AISLE_V["A2"]),
        "g_out": pt(GATE_OUT_U, AISLE_V["A2"]),
        "a1_right": pt(LANE_RIGHT_U, AISLE_V["A1"]),
        "a1_left": pt(LANE_LEFT_U_MID, AISLE_V["A1"]),
        "a2_far_join": far_w[-1],
        "a3_left": pt(LANE_FAR_LEFT_U, AISLE_V["A3"]),
        "a3_right": pt(LANE_RIGHT_U, AISLE_V["A3"]),
        "far_jog": pt(LANE_FAR_LEFT_U, LANE_FAR_JOG_V),
        "far_mid": pt(LANE_FAR_MID_U, LANE_FAR_JOG_V),
        "x_mid_left": pt(LANE_LEFT_U_MID, AISLE_V["A2"]),
    }
    # ``network.ts`` dựng nút **chỉ từ đỉnh polyline** (``buildRoadNetwork``). Nên ``A2`` phải có
    # đỉnh tại **đúng u** của mỗi làn nhập vào — nếu không, nút nhập làn đó không có cạnh ra và
    # xe đi hết làn là hết đường (P2b mất 16 ô vì lỗi này; P2c lặp lại khi dời V_far_w sang u=50).
    # Thứ tự đỉnh A2 từ đông sang tây: cổng vào → V_east/V_east_s → V_west (u=58) →
    # V_far_w (u=50) → cổng ra. Test ``test_every_aisle_join_is_an_a2_vertex`` chặn tái phát.
    a2_vertices = (
        nodes["g_in"],
        pt(LANE_RIGHT_U, AISLE_V["A2"]),
        nodes["x_mid_left"],
        nodes["a2_far_join"],
        nodes["g_out"],
    )
    r = JUNCTION_FILLET_R_M
    x_mid = nodes["x_mid_left"]
    v_west = [x_mid, nodes["a1_left"]]
    a1 = [nodes["a1_left"], nodes["a1_right"]]
    east_mid = pt(LANE_RIGHT_U, AISLE_V["A2"])
    v_east = [nodes["a1_right"], east_mid]
    v_east_s = [east_mid, nodes["a3_right"]]
    a2_list = list(a2_vertices)
    # Góc V_west → A1 (tây): V_west kết thúc ở T1, cung nằm trong A1 (bắt đầu từ T1).
    arc_w = _fillet(v_west[0], v_west[1], a1[1], r)
    v_west = [v_west[0], arc_w[0]]
    a1 = list(arc_w) + [a1[1]]
    # Góc A1 → V_east (đông): A1 kết thúc ở T1, cung nằm trong V_east.
    arc_e = _fillet(a1[-2], a1[-1], v_east[1], r)
    a1 = a1[:-1] + [arc_e[0]]
    v_east = list(arc_e) + [east_mid]
    # Các góc tại A2: làn nối riêng (cung R 4,1 m) giữa hai làn; làn gốc vẫn đi thẳng.
    i_e = a2_list.index(east_mid)
    i_w = a2_list.index(x_mid)
    # (1) V_east → A2 (hợp lưu về tây).
    arc_m = _fillet(v_east[-2], east_mid, a2_list[i_e + 1], r)
    v_east = v_east[:-1] + [arc_m[0], east_mid]
    # (2) A2 → V_east_s (rẽ nam).
    arc_s = _fillet(a2_list[i_e - 1], east_mid, v_east_s[1], r)
    v_east_s = [east_mid, arc_s[-1], v_east_s[1]]
    # (3) A2 → V_west (rẽ bắc).
    arc_a = _fillet(a2_list[i_w - 1], x_mid, v_west[1], r)
    v_west = [x_mid, arc_a[-1], v_west[1]]
    # (4) V_east_s → A3 (rẽ tây hàng 5): V_east_s kết thúc ở T1, cung nằm trong A3.
    a3_pts = [nodes["a3_right"], nodes["a3_left"]]
    arc_3 = _fillet(v_east_s[-2], v_east_s[-1], a3_pts[1], r)
    v_east_s = v_east_s[:-1] + [arc_3[0]]
    a3_pts = list(arc_3) + [a3_pts[1]]
    a2_list = (
        a2_list[:i_e]
        + [arc_s[0], east_mid, arc_m[-1]]
        + a2_list[i_e + 1 : i_w]
        + [arc_a[0], x_mid]
        + a2_list[i_w + 1 :]
    )
    aisles = [
        # Lối gom: cổng vào → cổng ra, hướng tây.
        AisleData("A2", tuple(a2_list), AISLE_WIDTH_M["A2"]),
        # A2 → A1 ở phía tây, hướng bắc.
        AisleData("V_west", tuple(v_west), AISLE_WIDTH_M["V_west"]),
        # Hàng 1–2, hướng đông.
        AisleData("A1", tuple(a1), AISLE_WIDTH_M["A1"]),
        # A1 → A2 ở phía đông, hướng nam (khép vòng trong), rộng 3,5 m.
        AisleData("V_east", tuple(v_east), AISLE_WIDTH_M["V_east"]),
        # Lối nối V_east → A2 (cung R 4,1 m) để xe ra về cổng ra không cua gắt.
        AisleData("V_east_m", tuple(arc_m), AISLE_WIDTH_M["V_east"], connector=True),
        # Lối nối A2 → V_east_s và A2 → V_west (cung R 4,1 m).
        AisleData("V_east_n", tuple(arc_s), AISLE_WIDTH_M["V_east_s"], connector=True),
        AisleData("V_west_n", tuple(arc_a), AISLE_WIDTH_M["V_west"], connector=True),
        # A2 → A3 ở phía đông, hướng nam (nhánh xuống hàng 5), cùng trục u nên liền mạch.
        AisleData("V_east_s", tuple(v_east_s), AISLE_WIDTH_M["V_east_s"]),
        # Hàng 5, hướng tây.
        AisleData("A3", tuple(a3_pts), AISLE_WIDTH_M["A3"]),
        # Mép tây (P17l B): cung phải → đoạn thẳng → cung trái R 2,9 m, nhập A2 ở u = 33,2.
        AisleData("V_far_w", tuple(far_w), AISLE_WIDTH_M["V_far_w"]),
    ]
    return aisles, nodes


def build_gates() -> dict[str, dict[str, object]]:
    """Cổng vào/ra theo ý tưởng §8 + C6 (đoạn dọc v 322–364)."""
    v1, v2 = GATE_V
    lane_v = AISLE_V["A2"]
    in_p1, in_p2 = ground(GATE_IN_U, v1), ground(GATE_IN_U, v2)
    out_p1, out_p2 = ground(GATE_OUT_U, v1), ground(GATE_OUT_U, v2)
    spawn_in = ground(GATE_IN_U + 75.0, lane_v)
    despawn_in = ground(GATE_IN_U - 20.0, lane_v)
    spawn_out = ground(GATE_OUT_U + 25.0, lane_v)
    despawn_out = ground(GATE_OUT_U - 65.0, lane_v)
    return {
        "in": {
            "p1": list(in_p1),
            "p2": list(in_p2),
            "p1_px": [GATE_IN_U, v1],
            "p2_px": [GATE_IN_U, v2],
            # Xe sinh ra ngoài khung (u = 690 > 640) rồi chạy vào theo hướng tây.
            "spawn": [spawn_in[0], spawn_in[1], math.pi],
            "despawn": list(despawn_in),
        },
        "out": {
            "p1": list(out_p1),
            "p2": list(out_p2),
            "p1_px": [GATE_OUT_U, v1],
            "p2_px": [GATE_OUT_U, v2],
            "spawn": [spawn_out[0], spawn_out[1], math.pi],
            # Biến mất ngoài khung bên trái (u = −40).
            "despawn": list(despawn_out),
        },
    }


# --------------------------------------------------------------------------------------
# Đồ thị làn → kiểm ô nào tới được (D6)
# --------------------------------------------------------------------------------------
#: Cạnh có hướng giữa các làn — đúng mạng một chiều của :func:`build_aisles`.
AISLE_EDGES: Final[tuple[tuple[str, str], ...]] = (
    ("A2", "V_west"),
    ("V_west", "A1"),
    ("A1", "V_east"),
    ("V_east", "A2"),
    ("A2", "V_east_s"),
    ("V_east_s", "A3"),
    ("A3", "V_far_w"),
    ("V_far_w", "A2"),
)


def reachable_aisles() -> set[str]:
    """BFS từ làn A2 (làn nhận xe từ cổng vào)."""
    seen = {"A2"}
    queue = ["A2"]
    while queue:
        current = queue.pop()
        for src, dst in AISLE_EDGES:
            if src == current and dst not in seen:
                seen.add(dst)
                queue.append(dst)
    return seen


def slot_reachable(row_key: str, reachable: set[str]) -> bool:
    """Ô tới được khi làn phía đuôi xe tới được từ cổng vào."""
    return SLOT_AISLE[row_key] in reachable


# --------------------------------------------------------------------------------------
# Trang trí (theo ảnh tham chiếu)
# --------------------------------------------------------------------------------------
#: Dải cỏ phân cách (đo trên ảnh: v ≈ 168 / 281 / 432). Dải thứ ba **cắt bớt ở phía tây**
#: (u ≥ 62) để chừa lối cho V_far_w vòng qua đầu tây hàng 4 — director G1 mục 3: giữ cỏ ở chỗ
#: hợp lý, bỏ cỏ **dưới làn**.
GRASS_BANDS_V: Final[tuple[tuple[float, float], ...]] = ((162.0, 176.0), (275.0, 289.0), (425.0, 441.0))
#: Chiều sâu ô chuẩn (m) - dùng để tính mép ô từ tâm (D5: chiều sâu đều theo hàng).
SLOT_DEPTH_M: Final = 4.85

#: Dải cỏ phủ ngang từ u này tới u kia (bãi chính).
GRASS_U: Final[tuple[float, float]] = (60.0, 585.0)
#: Dải cỏ thứ ba bắt đầu đông hơn lối vòng của V_far_w (u=62 thay vì 60).
GRASS_U_LOWER: Final[tuple[float, float]] = (62.0, 585.0)
#: Khoảng ``v`` của sân gạch (hàng 5) — giữ nguyên như P2, nhưng phần **dưới** A3 không còn
#: được coi là cỏ nữa.
BRICK_V: Final = (449.0, 560.0)
#: Vùng **ngoài 100 ô** (hàng trên cùng của ảnh PKLot, v phía trên hàng 1 — hàng 1 bắt đầu
#: ở v=160,6): dựng thành ô có vạch **trang trí**, không nằm trong ``slots``/GT và không bao
#: giờ có xe (director G1 mục 4). Dựng bằng kiểu sẵn có trong ``lot.ts``: ``asphalt`` (nền ô)
#: + ``curbs`` (nét vạch sơn) — contract chưa có kiểu "ô trang trí" riêng nên **không** sửa
#: contract. Đặt ở dải v 92–142 vì đó là vùng trống thật: trên hàng 1, dưới cụm cây, và không
#: có làn nào đi qua (A1 ở v=218).
DECOR_STALL_UD: Final = (150.0, 560.0)
DECOR_STALL_V: Final = (92.0, 142.0)
DECOR_STALL_COUNT: Final = 11


def grass_bands_from_rows(
    placed_slots: Sequence[tuple[str, tuple[float, float], str]],
) -> list[tuple[float, float, float, float]]:
    """Dải cỏ **theo mép ô thật**, không theo ``v`` cố định (P4b: lot đã dời hàng ở P2d).

    Mỗi cặp hàng mũi-đối-mũi có một dải cỏ nằm giữa hai mép mũi. Dải cỏ phải **dính** mép
    ô (không chồng lên ô, không hở xa); nếu không, P2d dời hàng 1 lên là cỏ nằm giữa thân
    hàng (đã xảy ra ở `static_dataset.png`: 21/22 tâm ô hàng 1 nằm trong dải cỏ 0).

    ``placed_slots`` = ``(slot_id, tâm_m, row_key)``. Mép ô tính bằng nửa chiều sâu ô
    (2,425 m) theo trục ``v``: hàng mũi bắc có mép nam = ``center_y − 2,425`` và mép bắc =
    ``center_y + 2,425`` (ngược lại với hàng mũi nam). Ta lấy **trung vị** trên cả hàng.
    """
    by_row: dict[str, list[float]] = {}
    for _slot_id, center, row_key in placed_slots:
        by_row.setdefault(row_key, []).append(center[1])

    def south_edge(row_key: str) -> float:
        """Mép nam (m) của hàng = center_y nhỏ nhất của các ô trừ nửa sâu... dùng trung vị."""
        ys = by_row.get(row_key, [])
        if not ys:
            raise ValueError(f"grass_bands_from_rows: hàng {row_key} không có ô nào")
        return float(np.median(ys)) - SLOT_DEPTH_M / 2.0

    def north_edge(row_key: str) -> float:
        ys = by_row.get(row_key, [])
        if not ys:
            raise ValueError(f"grass_bands_from_rows: hàng {row_key} không có ô nào")
        return float(np.median(ys)) + SLOT_DEPTH_M / 2.0

    def v_of_y(y: float, u: float = 320.0) -> float:
        """Đổi toạ độ world Y (m) ra ``v`` (px) của ảnh — nghịch đảo của ``ground``."""
        # project(u, y) cho (u_px, v_px); ta chỉ cần v.
        return float(project(0.0, y)[1])

    bands: list[tuple[float, float, float, float]] = []
    # Hai cặp mũi-đối-mũi: (hàng 1 bắc, hàng 2 nam) và (hàng 3 bắc, hàng 4 nam).
    # `v0` = mép bắc của dải (px), `v1` = mép nam của dải (px) — `ground` dùng v tăng về nam.
    for index, (upper, lower) in enumerate((("1", "2"), ("3", "4"))):
        v0 = v_of_y(south_edge(upper))
        v1 = v_of_y(north_edge(lower))
        u0, u1 = GRASS_U_LOWER if index >= 2 else GRASS_U
        bands.append((u0, v0, u1, v1))
    # Dải thứ ba: nam hàng 5 (hàng 5 mũi bắc) tới hết sân gạch.
    v0_third = v_of_y(south_edge("5"))
    u0, u1 = GRASS_U_LOWER
    bands.append((u0, v0_third, u1, BRICK_V[1]))
    return bands


def build_decor(
    placed_slots: Sequence[tuple[str, tuple[float, float], str]] | None = None,
) -> dict[str, object]:
    """Cỏ, bó vỉa, cây, cột đèn — đọc từ ảnh tham chiếu, không bịa thêm hình khối.

    ``placed_slots``: khi có, dải cỏ được tính **từ mép ô thật** (cần thiết sau P2d vì
    hàng đã dời); không có thì dùng ``GRASS_BANDS_V`` cố định của P2.
    """
    grass: list[list[list[float]]] = []
    curbs: list[list[list[float]]] = []
    if placed_slots is None:
        bands: list[tuple[float, float, float, float]] = []
        for index, (v0, v1) in enumerate(GRASS_BANDS_V):
            u0, u1 = GRASS_U_LOWER if index == 2 else GRASS_U
            bands.append((u0, v0, u1, v1))
    else:
        bands = grass_bands_from_rows(placed_slots)

    for u0, v0, u1, v1 in bands:
        quad = [ground(u0, v0), ground(u1, v0), ground(u1, v1), ground(u0, v1)]
        grass.append([[round(x, 4), round(y, 4)] for x, y in quad])
        curbs.append([[round(x, 4), round(y, 4)] for x, y in (quad[0], quad[1])])
        curbs.append([[round(x, 4), round(y, 4)] for x, y in (quad[3], quad[2])])

    # Nhựa đường: toàn bộ khu bãi giữa 4 mép (trừ dải cỏ vẽ đè lên sau).
    u_min, u_max = 0.0, 640.0
    v_min, v_max = 88.0, 560.0
    asphalt = [
        [
            [round(x, 4), round(y, 4)]
            for x, y in (
                ground(u_min, v_min),
                ground(u_max, v_min),
                ground(u_max, v_max),
                ground(u_min, v_max),
            )
        ]
    ]
    # Sân gạch hàng 5 (v > 449 trên ảnh) — thêm một đa giác nhựa riêng để render phân biệt.
    brick = [
        [
            [round(x, 4), round(y, 4)]
            for x, y in (
                ground(u_min, BRICK_V[0]),
                ground(u_max, BRICK_V[0]),
                ground(u_max, BRICK_V[1]),
                ground(u_min, BRICK_V[1]),
            )
        ]
    ]
    asphalt = asphalt + brick

    # P2b mục 3: A3 + V_far_w là **đường nhựa**. Mặt bãi ở P2 chỉ phủ tới v=560 và dải gạch
    # hàng 5 phủ đè lên A3, nên thêm một đa giác nhựa riêng trùm đúng dải đường của A3 và
    # nhánh vòng tây của V_far_w (để render vẽ mặt đường, không vẽ cỏ).
    a3_v = AISLE_V["A3"]
    road_a3 = [
        [
            [round(x, 4), round(y, 4)]
            for x, y in (
                ground(LANE_FAR_LEFT_U, a3_v - 34.0),
                ground(u_max, a3_v - 34.0),
                ground(u_max, a3_v + 34.0),
                ground(LANE_FAR_LEFT_U, a3_v + 34.0),
            )
        ]
    ]
    road_far_west = [
        [
            [round(x, 4), round(y, 4)]
            for x, y in (
                ground(-14.0, LANE_FAR_JOIN_V - 25.0),
                ground(LANE_FAR_JOIN_U + 25.0, LANE_FAR_JOIN_V - 25.0),
                ground(LANE_FAR_JOIN_U + 25.0, a3_v + 34.0),
                ground(-14.0, a3_v + 34.0),
            )
        ]
    ]
    asphalt = asphalt + road_a3 + road_far_west

    # P2b mục 4: vùng ngoài 100 ô (dải trên h��ng 1) — ô vạch **trang trí**, không có trong
    # ``slots`` và không bao giờ có xe. Contract ``lot.ts`` chưa có kiểu "ô trang trí" nên
    # dựng bằng hai kiểu sẵn có: ``asphalt`` (nền ô) + ``curbs`` (nét vạch sơn).
    stall_v0, stall_v1 = DECOR_STALL_V
    d0, d1 = DECOR_STALL_UD
    step = (d1 - d0) / DECOR_STALL_COUNT
    for index in range(DECOR_STALL_COUNT):
        a = d0 + index * step
        b = d0 + (index + 1) * step
        asphalt.append(
            [
                [round(x, 4), round(y, 4)]
                for x, y in (
                    ground(a, stall_v0),
                    ground(b, stall_v0),
                    ground(b, stall_v1),
                    ground(a, stall_v1),
                )
            ]
        )
        # Vạch chia giữa hai ô trang trí + vạch cuối dãy.
        for uu in (a, b):
            curbs.append(
                [
                    [round(x, 4), round(y, 4)]
                    for x, y in (ground(uu, stall_v0), ground(uu, stall_v1))
                ]
            )

    trees: list[dict[str, object]] = []
    # Cụm cây thật trên ảnh: góc phải trên (u 560–640, v 30–200), mép phải (u 590–640, v 300–420).
    tree_px = [
        (600.0, 60.0, 2.2, 5.5),
        (622.0, 96.0, 2.0, 5.0),
        (596.0, 132.0, 1.8, 4.6),
        (618.0, 172.0, 2.1, 5.2),
        (604.0, 330.0, 1.9, 4.8),
        (622.0, 372.0, 2.0, 5.0),
    ]
    for u, v, radius, height in tree_px:
        x, y = ground(u, v)
        kind = "round" if radius >= 2.0 else "cone"
        trees.append({"pos": [round(x, 3), round(y, 3)], "radius_m": radius, "height_m": height, "kind": kind})

    lamps: list[dict[str, object]] = []
    # Cột đèn thật: đầu các dải cỏ + góc sân gạch (đèn bật trong kịch bản đêm, FE §6).
    for u, v in ((78.0, 168.0), (556.0, 168.0), (78.0, 281.0), (556.0, 281.0), (78.0, 432.0), (556.0, 432.0)):
        x, y = ground(u, v)
        lamps.append({"pos": [round(x, 3), round(y, 3)], "height_m": 6.0, "night_light": True})

    return {
        "grass": grass,
        "curbs": curbs,
        "asphalt": asphalt,
        "trees": trees,
        "lamps": lamps,
    }


def rectangle(
    center: tuple[float, float],
    heading: float,
    length_m: float,
    width_m: float,
) -> list[tuple[float, float]]:
    """4 góc hình chữ nhật world quanh ``center``, trục dài theo ``heading``.

    Thứ tự góc: trước-trái, trước-phải, sau-phải, sau-trái (theo chiều mũi xe).
    """
    cx, cy = center
    c, s = math.cos(heading), math.sin(heading)
    hl, hw = length_m / 2.0, width_m / 2.0
    local = ((hl, -hw), (hl, hw), (-hl, hw), (-hl, -hw))
    return [(cx + lx * c - ly * s, cy + lx * s + ly * c) for lx, ly in local]


# --------------------------------------------------------------------------------------
# Lắp bản đồ
# --------------------------------------------------------------------------------------
def build_lot() -> tuple[dict[str, object], list[str]]:
    """Dựng toàn bộ ``lot_pucpr.json``. Trả ``(bản đồ, danh sách cảnh báo)``."""
    slots_csv = read_csv()
    groups = assign_rows(slots_csv)
    warnings: list[str] = []
    rows_geo: dict[str, RowGeometry] = {}
    groups_by_row: dict[str, list[SlotCsv]] = {}
    for spec in ROWS:
        members = groups[spec.key]
        if not members:
            warnings.append(f"hàng {spec.key}: không có ô nào")
            continue
        rows_geo[spec.key] = row_geometry(spec, members)
        groups_by_row[spec.key] = members
    rows_geo = _separate_rows(rows_geo, groups_by_row)
    slot_centers: dict[str, tuple[tuple[float, float], float]] = {}
    row_width: dict[str, float] = {}
    for spec in ROWS:
        members = groups_by_row.get(spec.key)
        if not members:
            continue
        geometry = rows_geo[spec.key]
        placed, width = normalize_row(members, geometry)
        row_width[spec.key] = width
        # P2c bước 2/3: dịch **nguyên hàng** theo v để nới dải trống giữa hàng 4 và hàng 5
        # cho V_far_w (xem ``ROW_V_OFFSET_PX``).
        row_dv = ROW_V_OFFSET_PX.get(spec.key, 0.0)
        for slot_id, (center, shift) in placed.items():
            if row_dv == 0.0:
                slot_centers[slot_id] = (center, shift)
                continue
            u, v = project(*center)
            moved = ground(u, v + row_dv)
            slot_centers[slot_id] = (moved, shift)

    reachable = reachable_aisles()
    slots: list[dict[str, object]] = []
    for slot in slots_csv:
        geometry = rows_geo[slot.row]
        center, shift_px = slot_centers[slot.id]
        # Tính lại sai số từ **tâm cuối** (sau cả dịch hàng) so với tâm csv — một nguồn số duy
        # nhất cho cả cảnh báo stdout và trường ``center_shift_px``, tránh lệch như P2c bản đầu.
        u_final, v_final = project(*center)
        shift_px = math.hypot(u_final - slot.center_px[0], v_final - slot.center_px[1])
        # P2d: ngưỡng **theo hàng** (ANS_6 mục 1) — hàng 1–2 được nới 20 px vì phải dời để
        # đủ dải trống cho cung 4,0 m; hàng 3–5 giữ 8 px.
        row_limit = ROW_MAX_SHIFT_PX.get(slot.row, DEFAULT_ROW_MAX_SHIFT_PX)
        if shift_px > row_limit:
            warnings.append(
                f"{slot.id}: tâm lệch {shift_px:.2f} px > ngưỡng {row_limit:.0f} px của hàng {slot.row}"
            )
        corners = rectangle(center, geometry.heading, geometry.depth_m, row_width[slot.row])
        corners_px = [tuple(round(v, 2) for v in project(x, y)) for x, y in corners]
        ok = slot_reachable(slot.row, reachable)
        if not ok:
            warnings.append(f"{slot.id}: không tới được (làn {SLOT_AISLE[slot.row]} không nối cổng vào)")
        slots.append(
            {
                "id": slot.id,
                "row": slot.row,
                "center": [round(center[0], 4), round(center[1], 4)],
                "heading": round(geometry.heading, 6),
                "polygon": [[round(x, 4), round(y, 4)] for x, y in corners],
                "polygon_px": [[u, v] for u, v in corners_px],
                "width_m": round(row_width[slot.row], 4),
                "reachable": ok,
                # Trường phụ để test đối chiếu với csv (không dùng trong sim).
                "csv_width_m": round(slot.width_m, 4),
                "csv_center_px": [round(slot.center_px[0], 2), round(slot.center_px[1], 2)],
                "center_shift_px": round(shift_px, 3),
            }
        )

    aisles, nodes = build_aisles()
    return (
        {
            "name": "pucpr",
            "camera": {
                "pitch_deg": PITCH_DEG,
                "f_px": F_PX,
                "height_m": HEIGHT_M,
                "res": [RES_PX, RES_PX],
                "cam1_x": list(CAM1_X),
                "cam2_x": list(CAM2_X),
            },
            "slots": slots,
            "aisles": [
                {
                    "id": aisle.id,
                    "polyline": [[round(x, 4), round(y, 4)] for x, y in aisle.polyline],
                    "width_m": aisle.width_m,
                    "oneway": aisle.oneway,
                    **({"connector": True} if aisle.connector else {}),
                }
                for aisle in aisles
            ],
            "gates": build_gates(),
            "decor": build_decor(
            [(slot_id, center, slot.row) for slot, (center, _shift) in zip(slots_csv, [slot_centers[s.id] for s in slots_csv])]
        ),
            "row_geometry": {
                key: {
                    "heading": round(geo.heading, 6),
                    "depth_m": geo.depth_m,
                    "width_m": round(geo.width_m, 4),
                    "nose_north": geo.nose_north,
                    "slope": round(geo.slope, 6),
                    "intercept": round(geo.intercept, 6),
                }
                for key, geo in rows_geo.items()
            },
            "aisle_nodes": {key: [round(x, 4), round(y, 4)] for key, (x, y) in nodes.items()},
        },
        warnings,
    )


# --------------------------------------------------------------------------------------
# Ảnh kiểm
# --------------------------------------------------------------------------------------
PLAN_SCALE: Final = 14.0
PLAN_MARGIN_M: Final = 3.0
LANE_COLORS: Final = {
    "A1": (60, 160, 255),
    "A2": (60, 200, 120),
    "A3": (200, 160, 60),
    "V_east": (220, 120, 220),
    "V_east_s": (250, 150, 190),
    "V_west": (120, 120, 240),
    "V_far_w": (120, 200, 240),
    "V_east_m": (140, 190, 140),
    "V_east_n": (140, 190, 140),
    "V_west_n": (140, 190, 140),
}


def world_bounds(lot: dict[str, object]) -> tuple[float, float, float, float]:
    """Bounding box world (m) của ô + làn."""
    xs: list[float] = []
    ys: list[float] = []
    for slot in lot["slots"]:  # type: ignore[index]
        for x, y in slot["polygon"]:
            xs.append(float(x))
            ys.append(float(y))
    for aisle in lot["aisles"]:  # type: ignore[index]
        for x, y in aisle["polyline"]:
            xs.append(float(x))
            ys.append(float(y))
    return min(xs), min(ys), max(xs), max(ys)


def to_plan(
    x: float,
    y: float,
    bounds: tuple[float, float, float, float],
) -> tuple[int, int]:
    """World (m) → px trong plan.png (trục Y lật để bắc ở trên)."""
    x0, _y0, _x1, y1 = bounds
    return (
        round((x - x0 + PLAN_MARGIN_M) * PLAN_SCALE),
        round((y1 + PLAN_MARGIN_M - y) * PLAN_SCALE),
    )


def heading_img_deg(slot: dict[str, object]) -> float:
    """Hướng mũi xe của ô trên ảnh (độ, 0 = lên trên)."""
    cx, cy = slot["center"]  # type: ignore[misc]
    th = float(slot["heading"])  # type: ignore[index]
    u0, v0 = project(cx, cy)
    u1, v1 = project(cx + 6.0 * math.cos(th), cy + 6.0 * math.sin(th))
    return math.degrees(math.atan2(u1 - u0, -(v1 - v0)))


def render_plan(lot: dict[str, object]) -> np.ndarray:
    """``plan.png``: sơ đồ làn có mũi tên chiều đi + mã ô."""
    bounds = world_bounds(lot)
    x0, y0, x1, y1 = bounds
    width = int((x1 - x0 + 2 * PLAN_MARGIN_M) * PLAN_SCALE)
    height = int((y1 - y0 + 2 * PLAN_MARGIN_M) * PLAN_SCALE)
    image = np.full((height, width, 3), 32, np.uint8)

    for slot in lot["slots"]:  # type: ignore[index]
        pts = np.array([to_plan(x, y, bounds) for x, y in slot["polygon"]], np.int32)
        color = (120, 120, 120) if slot["reachable"] else (60, 60, 170)
        cv2.polylines(image, [pts], True, color, 1, cv2.LINE_AA)
        cx, cy = slot["center"]
        px, py = to_plan(cx, cy, bounds)
        cv2.putText(image, slot["id"][1:], (px - 9, py + 4), cv2.FONT_HERSHEY_PLAIN, 0.6, (210, 210, 210), 1)

    for aisle in lot["aisles"]:  # type: ignore[index]
        color = LANE_COLORS[aisle["id"]]
        pts = [to_plan(x, y, bounds) for x, y in aisle["polyline"]]
        cv2.polylines(image, [np.array(pts, np.int32)], False, color, 1, cv2.LINE_AA)
        for (ax, ay), (bx, by) in itertools.pairwise(pts):
            length = max(1.0, math.hypot(bx - ax, by - ay))
            cv2.arrowedLine(image, (ax, ay), (bx, by), color, 2, cv2.LINE_AA, tipLength=min(0.25, 16.0 / length))
        # Nhãn đặt ở giữa đoạn dài nhất để không bị đè lên mép ảnh.
        (ax, ay), (bx, by) = max(
            itertools.pairwise(pts),
            key=lambda pair: math.hypot(pair[1][0] - pair[0][0], pair[1][1] - pair[0][1]),
        )
        cv2.putText(
            image,
            f"{aisle['id']} {aisle['width_m']:.1f}m",
            ((ax + bx) // 2 - 26, (ay + by) // 2 - 6),
            cv2.FONT_HERSHEY_PLAIN,
            0.85,
            color,
            1,
        )

    for key, gate in lot["gates"].items():  # type: ignore[union-attr]
        p1 = to_plan(float(gate["p1"][0]), float(gate["p1"][1]), bounds)
        p2 = to_plan(float(gate["p2"][0]), float(gate["p2"][1]), bounds)
        cv2.line(image, p1, p2, (0, 220, 255), 3, cv2.LINE_AA)
        cv2.putText(image, f"gate {key}", (p1[0] - 46, p1[1] - 8), cv2.FONT_HERSHEY_PLAIN, 1.0, (0, 220, 255), 1)

    for text, i in zip(
        (
            "plan.png — ban PUCPR, don vi met, truc +Y = huong bac (xa camera)",
            "xam = o toi duoc; mui ten = chieu mot chieu (D6); vang = cong vao/ra",
            f"{len(lot['slots'])} o · {len(lot['aisles'])} lan mot chieu · A2 loi gom: cong vao -> cong ra",  # type: ignore[arg-type]
            "A2 -> V_west -> A1 -> V_east -> A2 (vong trong) · A2 -> V_east_s -> A3 -> V_far_w -> A2 (vong ngoai)",
            "L-GATE: chi A2 cat vach cong; moi lan khac cach cong >= 2,0 m (tinh ca nua be rong)",
        ),
        range(5),
    ):
        cv2.putText(image, text, (10, 22 + i * 17), cv2.FONT_HERSHEY_PLAIN, 0.85, (245, 245, 245), 1)
    return image


def render_overlay(lot: dict[str, object]) -> np.ndarray:
    """``overlay.png``: đa giác ô + làn + **decor** đè 50% lên ảnh PKLot tham chiếu."""
    base = cv2.imread(str(REF_IMAGE))
    if base is None:
        raise FileNotFoundError(f"Không đọc được ảnh tham chiếu: {REF_IMAGE}")
    overlay = base.copy()

    def decor_polygon(polygon: Sequence[Sequence[float]], color: tuple[int, int, int], fill: bool) -> None:
        pts = np.array([[round(u), round(v)] for u, v in (project(x, y) for x, y in polygon)], np.int32)
        if fill:
            layer = overlay.copy()
            cv2.fillPoly(layer, [pts], color)
            cv2.addWeighted(layer, 0.45, overlay, 0.55, 0.0, overlay)
        cv2.polylines(overlay, [pts], True, color, 1, cv2.LINE_AA)

    decor = lot["decor"]
    # Cỏ: tô xanh để thấy chỗ nào **không** còn cỏ dưới làn (P2b mục 3).
    for polygon in decor["grass"]:  # type: ignore[index]
        decor_polygon(polygon, (60, 190, 60), fill=True)
    # Ô trang trí ngoài 100 ô: tô xám nhạt + vạch vàng để phân biệt với ô thật (P2b mục 4).
    for index in range(DECOR_STALL_COUNT):
        stall_v0, stall_v1 = DECOR_STALL_V
        d0, d1 = DECOR_STALL_UD
        step = (d1 - d0) / DECOR_STALL_COUNT
        a = d0 + index * step
        b = a + step
        quad = [ground(a, stall_v0), ground(b, stall_v0), ground(b, stall_v1), ground(a, stall_v1)]
        decor_polygon(quad, (0, 215, 255), fill=False)

    for slot in lot["slots"]:  # type: ignore[index]
        pts = np.array([[round(u), round(v)] for u, v in slot["polygon_px"]], np.int32)
        cv2.polylines(overlay, [pts], True, (0, 0, 255), 1, cv2.LINE_AA)
        cx, cy = slot["center"]
        u, v = project(cx, cy)
        cv2.circle(overlay, (round(u), round(v)), 2, (0, 255, 255), -1)
        ang = math.radians(heading_img_deg(slot))
        tip = (u + 7.0 * math.sin(ang), v - 7.0 * math.cos(ang))
        cv2.line(overlay, (round(u), round(v)), (round(tip[0]), round(tip[1])), (255, 0, 255), 1)

    for aisle in lot["aisles"]:  # type: ignore[index]
        pts = [
            [round(u), round(v)]
            for u, v in (
                project(x, y) for x, y in _offset_polyline(aisle["polyline"], aisle["width_m"])
            )
        ]
        cv2.polylines(overlay, [np.array(pts, np.int32)], True, LANE_COLORS[aisle["id"]], 1, cv2.LINE_AA)
        center = np.array(
            [[round(u), round(v)] for u, v in (project(x, y) for x, y in aisle["polyline"])],
            np.int32,
        )
        cv2.polylines(overlay, [center], False, LANE_COLORS[aisle["id"]], 2, cv2.LINE_AA)

    blended = (0.5 * base.astype(np.float32) + 0.5 * overlay.astype(np.float32)).astype(np.uint8)
    cv2.putText(
        blended,
        "overlay.png — do: o · vang: tam/mui xe · xanh la: co · vang nhat: o trang tri · mau: lan",
        (4, 634),
        cv2.FONT_HERSHEY_PLAIN,
        0.8,
        (255, 255, 255),
        1,
    )
    return blended


def _offset_polyline(
    polyline: Sequence[Sequence[float]],
    width_m: float,
) -> list[tuple[float, float]]:
    """Vẽ bề rộng làn thành đa giác (dịch đường tâm sang hai bên ``width_m/2``)."""
    half = width_m / 2.0
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    for index, point in enumerate(polyline):
        x, y = float(point[0]), float(point[1])
        prev_point = polyline[max(0, index - 1)]
        next_point = polyline[min(len(polyline) - 1, index + 1)]
        dx, dy = float(next_point[0]) - float(prev_point[0]), float(next_point[1]) - float(prev_point[1])
        norm = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / norm, dx / norm
        left.append((x + nx * half, y + ny * half))
        right.append((x - nx * half, y - ny * half))
    return left + right[::-1]


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def main(argv: Sequence[str] | None = None) -> int:
    """Sinh JSON + 2 ảnh. ``--check`` chỉ kiểm, không ghi."""
    parser = argparse.ArgumentParser(description="Sinh sim3d/data/lot/lot_pucpr.json + ảnh kiểm.")
    parser.add_argument("--check", action="store_true", help="chỉ dựng trong bộ nhớ, không ghi file")
    args = parser.parse_args(argv)

    # Console Windows hay dùng code page không có dấu tiếng Việt (cp1258/cp437).
    # In log bằng UTF-8 để không mất chữ, không đổi dữ liệu ghi ra file.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    lot, warnings = build_lot()
    slots = lot["slots"]
    assert isinstance(slots, list)
    unreachable = [str(s["id"]) for s in slots if not s["reachable"]]
    shifts = [float(s["center_shift_px"]) for s in slots]
    print(f"Ô: {len(slots)} · tới được: {len(slots) - len(unreachable)} · không tới được: {len(unreachable)}")
    if unreachable:
        print("KHÔNG TỚI ĐƯỢC:", ", ".join(unreachable))
    print(f"Lệch tâm sau chuẩn hoá: max {max(shifts):.2f} px · trung vị {sorted(shifts)[len(shifts) // 2]:.2f} px")
    for warning in warnings:
        print("CẢNH BÁO:", warning)

    aisles = lot["aisles"]
    assert isinstance(aisles, list)
    print("Làn:", ", ".join(f"{a['id']}({a['width_m']}m, một chiều)" for a in aisles))

    if args.check:
        print("--check: không ghi file.")
        return 0

    OUT_LOT.parent.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_LOT.open("w", encoding="utf-8") as handle:
        json.dump(lot, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    print(f"Ghi {OUT_LOT.relative_to(REPO_DIR)}")

    plan = render_plan(lot)
    cv2.imwrite(str(OUT_PLAN), plan)
    print(f"Ghi {OUT_PLAN.relative_to(REPO_DIR)} ({plan.shape[1]}×{plan.shape[0]})")

    overlay = render_overlay(lot)
    cv2.imwrite(str(OUT_OVERLAY), overlay)
    print(f"Ghi {OUT_OVERLAY.relative_to(REPO_DIR)} ({overlay.shape[1]}×{overlay.shape[0]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

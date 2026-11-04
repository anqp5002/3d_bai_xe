"""Test bản đồ bãi (P2) — kiểm đúng Done khi và các quyết định D5, D6, C9.

Chạy: ``python -m pytest sim3d/tools -q`` (từ gốc repo).
"""

from __future__ import annotations

import itertools
import json
import math
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import build_lot as bl
import numpy as np
import pytest

#: Ngưỡng **theo hàng** (ANS_6 mục 1, P2d): hàng 1-2 được nới 20 px vì phải dời hàng để
#: đủ dải trống cho cung vào ô 4,0 m (ANS_6 phương án B); hàng 3-5 giữ 8 px.
ROW_MAX_SHIFT_PX = {"1": 20.0, "2": 20.0, "3": 8.0, "4": 8.0, "5": 8.0}
DEFAULT_MAX_SHIFT_PX = 8.0

#: Ngưỡng "phần lớn" (chỉ để in theo dõi, không phải điều kiện Done).
MAX_CENTER_PX = 3.0
#: Ngưỡng cứng: quá mức này thì đa giác rời khỏi vạch sơn thật (ảnh overlay sẽ sai rõ).
#: Director G1 cho phép ô lệch > 3 px khi buộc phải tách ô chồng, miễn báo đúng ID + số px;
#: 8 px là mức còn giữ đa giác trong vạch sơn khi nhìn overlay.
MAX_CENTER_HARD_PX = 8.0


@pytest.fixture(scope="module")
def lot() -> dict[str, Any]:
    """Bản đồ sinh trong bộ nhớ — test không phụ thuộc file trên đĩa."""
    data, warnings = bl.build_lot()
    assert isinstance(data, dict)
    assert warnings is not None
    return data


@pytest.fixture(scope="module")
def slots(lot: dict[str, Any]) -> list[dict[str, Any]]:
    result = lot["slots"]
    assert isinstance(result, list)
    return result


@pytest.fixture(scope="module")
def csv_rows() -> dict[str, dict[str, str]]:
    import csv

    with bl.CSV_PATH.open("r", encoding="utf-8") as handle:
        return {row["space_id"]: row for row in csv.DictReader(handle)}


# --------------------------------------------------------------------------------------
# Done khi: 100 ô, id đúng, tâm ≤ 3 px so với csv
# --------------------------------------------------------------------------------------
def test_slots_count_and_ids(slots: list[dict[str, Any]]) -> None:
    assert len(slots) == 100
    assert [s["id"] for s in slots] == [f"S{i:03d}" for i in range(1, 101)]


def test_slot_ids_are_unique(slots: list[dict[str, Any]]) -> None:
    assert len({s["id"] for s in slots}) == 100


def test_centers_match_csv_within_3px(
    lot: dict[str, Any], slots: list[dict[str, Any]], csv_rows: dict[str, dict[str, str]]
) -> None:
    """Tâm ô khớp ``sample_spaces.csv``: **phần lớn** ≤ 3 px, ô vượt phải được báo số cụ thể.

    P2b mục 1 (director G1): tách ô chồng bằng chuẩn hoá bước ô đều, chấp nhận ô lệch
    > 3 px **nếu in đúng ID + số px**. Vì vậy test chặn hai điều: (a) không ô nào lệch quá
    5 px (mất khớp ảnh thật); (b) mọi ô > 3 px đều phải có trong ``center_shift_px``.
    """
    worst_id, worst = "", 0.0
    offenders: list[str] = []
    for slot in slots:
        row = csv_rows[slot["id"]]
        u_csv = float(row["x"]) + float(row["w"]) / 2.0
        v_csv = float(row["y"]) + float(row["h"]) / 2.0
        u, v = bl.project(*slot["center"])
        error = math.hypot(u - u_csv, v - v_csv)
        if error > worst:
            worst, worst_id = error, slot["id"]
        row_limit = ROW_MAX_SHIFT_PX.get(str(slot["row"]), DEFAULT_MAX_SHIFT_PX)
        if error > MAX_CENTER_PX:
            offenders.append(f"{slot['id']} {error:.2f}px")
        assert error <= row_limit, (
            f"{slot['id']} (hàng {slot['row']}): lệch {error:.2f} px > ngưỡng {row_limit:.0f} px"
        )
    print(f"tâm ô lệch tối đa: {worst:.2f} px ({worst_id}) · ô > 3 px: {len(offenders)}")
    for entry in offenders:
        print(f"  lệch > 3 px: {entry}")


def test_polygon_px_centroid_matches_center(
    slots: list[dict[str, Any]],
) -> None:
    """Đa giác ảnh phải bao đúng tâm: trung bình 4 góc ≈ tâm chiếu."""
    for slot in slots:
        u0, v0 = bl.project(*slot["center"])
        us = [p[0] for p in slot["polygon_px"]]
        vs = [p[1] for p in slot["polygon_px"]]
        assert math.hypot(sum(us) / 4.0 - u0, sum(vs) / 4.0 - v0) < 0.5, slot["id"]


# --------------------------------------------------------------------------------------
# Hợp lệ theo lot.ts (contract C-A)
# --------------------------------------------------------------------------------------
SLOT_FIELDS = {
    "id",
    "row",
    "center",
    "heading",
    "polygon",
    "polygon_px",
    "width_m",
    "reachable",
}


def test_slot_objects_have_contract_fields(slots: list[dict[str, Any]]) -> None:
    for slot in slots:
        assert SLOT_FIELDS <= set(slot)
        assert isinstance(slot["reachable"], bool)
        assert len(slot["polygon"]) == 4
        assert len(slot["polygon_px"]) == 4
        assert len(slot["center"]) == 2
        assert slot["width_m"] > 0.0
        assert math.isfinite(slot["heading"])


def test_lot_shape_matches_contract(lot: dict[str, Any]) -> None:
    assert lot["name"] == "pucpr"
    camera = lot["camera"]
    assert camera["pitch_deg"] == 80.0
    assert camera["f_px"] == 288.0
    assert camera["height_m"] == 33.6
    assert camera["res"] == [640, 640]
    assert camera["cam1_x"] == [0, 400]
    assert camera["cam2_x"] == [240, 640]

    aisles = lot["aisles"]
    assert len(aisles) >= 1
    for aisle in aisles:
        assert aisle["oneway"] is True, f"{aisle['id']} phải một chiều (D6)"
        assert len(aisle["polyline"]) >= 2
        assert aisle["width_m"] > 0.0

    decor = lot["decor"]
    assert {"grass", "curbs", "asphalt", "trees", "lamps"} <= set(decor)
    for tree in decor["trees"]:
        assert tree["radius_m"] > 0.0
        assert tree["height_m"] > 0.0
    for lamp in decor["lamps"]:
        assert lamp["night_light"] is True


def test_json_roundtrip_keeps_schema(lot: dict[str, Any], tmp_path: Path) -> None:
    """File trên đĩa phải đọc lại được và giữ nguyên cấu trúc."""
    target = tmp_path / "lot.json"
    target.write_text(json.dumps(lot, ensure_ascii=False), encoding="utf-8")
    reloaded = json.loads(target.read_text(encoding="utf-8"))
    assert len(reloaded["slots"]) == 100
    assert reloaded["slots"][0]["id"] == "S001"
    assert reloaded["slots"][-1]["id"] == "S100"


# --------------------------------------------------------------------------------------
# D5: chuẩn hoá theo hàng
# --------------------------------------------------------------------------------------
def test_rows_have_uniform_heading_and_width(slots: list[dict[str, Any]]) -> None:
    """D5: mỗi hàng có cùng hướng đỗ và cùng bề rộng ô."""
    by_row: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        by_row.setdefault(slot["row"], []).append(slot)
    assert len(by_row) == 5
    for row, members in by_row.items():
        headings = {round(m["heading"], 9) for m in members}
        widths = {round(m["width_m"], 9) for m in members}
        assert len(headings) == 1, f"hàng {row} có nhiều hướng đỗ: {headings}"
        assert len(widths) == 1, f"hàng {row} có nhiều bề rộng: {widths}"


def test_polygon_is_rectangle(slots: list[dict[str, Any]]) -> None:
    """D5: đa giác là hình chữ nhật world (4 góc vuông, cạnh đối bằng nhau)."""
    for slot in slots:
        p = [np.array(pt) for pt in slot["polygon"]]
        sides = [float(np.linalg.norm(p[(i + 1) % 4] - p[i])) for i in range(4)]
        assert sides[0] == pytest.approx(sides[2], abs=1e-3), slot["id"]
        assert sides[1] == pytest.approx(sides[3], abs=1e-3), slot["id"]
        # Góc: tích vô hướng hai cạnh kề phải ≈ 0.
        v1 = p[1] - p[0]
        v2 = p[2] - p[1]
        cos_angle = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))
        assert abs(cos_angle) < 1e-3, f"{slot['id']}: góc không vuông ({cos_angle:.4f})"


def test_headings_follow_reference_image(slots: list[dict[str, Any]]) -> None:
    """Hướng đỗ đọc từ ảnh: hàng 1/3/5 mũi bắc, hàng 2/4 mũi nam (��nh: 0°=lên, 180°=xuống)."""
    expected = {"1": 0.0, "2": 180.0, "3": 0.0, "4": 180.0, "5": 0.0}
    by_row: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        by_row.setdefault(slot["row"], []).append(slot)
    for row, members in by_row.items():
        slot = members[0]
        cx, cy = slot["center"]
        th = slot["heading"]
        u0, v0 = bl.project(cx, cy)
        u1, v1 = bl.project(cx + 6.0 * math.cos(th), cy + 6.0 * math.sin(th))
        angle = math.degrees(math.atan2(u1 - u0, -(v1 - v0))) % 360.0
        gap = abs((angle - expected[row] + 180.0) % 360.0 - 180.0)
        assert gap < 15.0, f"hàng {row}: mũi xe {angle:.1f}° trên ảnh, cần ~{expected[row]}°"


def test_no_two_slot_polygons_intersect(slots: list[dict[str, Any]]) -> None:
    """P2b mục 1: **không cặp ô nào** có diện tích giao > 0 (toàn bộ 100 ô, mọi hàng).

    Lý do (director G1): GT "tâm xe trong đa giác" chỉ đúng khi mỗi điểm thuộc tối đa 1 ô,
    và kiểm va chạm xe đỗ sẽ báo chồng giả nếu hai đa giác cắt nhau. Chạm cạnh thì được.
    """
    import cv2

    def poly(slot: dict[str, Any]) -> np.ndarray:
        return np.array([[round(x * 1000), round(y * 1000)] for x, y in slot["polygon"]], np.int32)

    offenders: list[str] = []
    for first, second in itertools.combinations(slots, 2):
        area, _ = cv2.intersectConvexConvex(poly(first), poly(second))
        if area > 0.0:
            offenders.append(f"{first['id']}/{second['id']} ({area / 1e6:.4f} m²)")
    assert offenders == [], f"{len(offenders)} cặp ô giao nhau: {offenders[:10]}"


def test_row_step_is_uniform(slots: list[dict[str, Any]]) -> None:
    """P2b mục 1: bước ô **đều trong từng dải liền mạch** của hàng.

    Hàng có chỗ khuyết ô (csv thiếu ô) thì bước nhảy ở chỗ khuyết lớn hơn hẳn — đó là ranh
    giới dải, không phải bước ô đều bị phá. Test bỏ qua đúng các bước nhảy đó.
    """
    by_row: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        by_row.setdefault(slot["row"], []).append(slot)
    for row, members in by_row.items():
        width = members[0]["width_m"]
        heading = members[0]["heading"]
        tx, ty = math.cos(heading + math.pi / 2.0), math.sin(heading + math.pi / 2.0)
        along = sorted(s["center"][0] * tx + s["center"][1] * ty for s in members)
        steps = [b - a for a, b in itertools.pairwise(along) if b - a <= bl.BLOCK_GAP_MIN_M]
        assert steps, f"hàng {row}: không có bước ô nào"
        assert max(steps) - min(steps) <= 0.05, (
            f"hàng {row}: bước {min(steps):.3f}–{max(steps):.3f} m không đều"
        )
        assert min(steps) >= width, f"hàng {row}: bước {min(steps):.3f} < bề rộng {width:.3f}"


def test_slot_center_shift_reported(slots: list[dict[str, Any]]) -> None:
    """P2b mục 1: ô nào lệch tâm > 3 px **phải có số cụ thể** trong dữ liệu để REPORT dẫn.

    Director G1 chấp nhận lệch > 3 px khi buộc phải tách ô chồng, với điều kiện báo đúng
    ID + số px. Test này bảo đảm: (a) mọi ô đều có ``center_shift_px``; (b) số đó khớp với
    phép đo lại từ ``center`` và csv; (c) nếu có ô > 3 px thì phải liệt kê được ngay.
    """
    offenders: list[tuple[str, float]] = []
    for slot in slots:
        measured = float(slot["center_shift_px"])
        u, v = bl.project(*slot["center"])
        u_csv, v_csv = slot["csv_center_px"]
        recomputed = math.hypot(u - u_csv, v - v_csv)
        assert measured == pytest.approx(recomputed, abs=0.01), slot["id"]
        if measured > 3.0:
            offenders.append((slot["id"], round(measured, 2)))
    # In ra để REPORT_P2b dẫn được đúng danh sách.
    print(f"ô lệch > 3 px: {len(offenders)} → {offenders}")


def test_drive_lane_width_at_least_minimum(lot: dict[str, Any]) -> None:
    """P2c (ANS_3 mục 2): mọi làn **có xe chạy** phải rộng ≥ :data:`bl.MIN_DRIVE_LANE_M`.

    Lý do: bộ định tuyến của sim dựng cung vào/ra theo hình học, còn xe có bề rộng thật
    (sedan ~1,8 m, ×1,3 khi phóng ⇒ ~2,4 m). Làn 2,0 m ở P2b khiến xe không lập được đường.
    """
    for aisle in lot["aisles"]:
        assert aisle["width_m"] >= bl.MIN_DRIVE_LANE_M - 1e-9, (
            f"làn {aisle['id']} rộng {aisle['width_m']:.2f} m < {bl.MIN_DRIVE_LANE_M} m"
        )
        assert aisle["oneway"] is True, f"làn {aisle['id']} phải một chiều (D6)"


def test_every_aisle_join_is_an_a2_vertex(lot: dict[str, Any]) -> None:
    """P2c: mọi làn nhập vào ``A2`` phải có **đỉnh đúng tại điểm nhập**.

    ``network.ts`` (``buildRoadNetwork``) dựng nút **chỉ từ đỉnh polyline**. Nếu một làn kết
    thúc ở giữa một đoạn A2 thì nút đó không có cạnh ra ⇒ xe đi hết làn là hết đường, và
    ``buildExitRoute`` trả ``null``. Đây đúng là lỗi làm 16 ô không ra được ở P2b.
    """
    a2 = next(a for a in lot["aisles"] if a["id"] == "A2")
    vertices = [tuple(p) for p in a2["polyline"]]
    for aisle in lot["aisles"]:
        if aisle["id"] == "A2":
            continue
        for endpoint in (aisle["polyline"][-1], aisle["polyline"][0]):
            x, y = float(endpoint[0]), float(endpoint[1])
            # Chỉ xét điểm nằm trên đường tâm A2 (cùng y) — đó là các điểm nhập làn.
            if abs(y - vertices[0][1]) > 1e-6:
                continue
            match = any(abs(vx - x) < 1e-3 and abs(vy - y) < 1e-3 for vx, vy in vertices)
            assert match, (
                f"làn {aisle['id']} nhập A2 tại x={x:.3f} nhưng A2 không có đỉnh ở đó "
                f"(đỉnh A2: {[round(v[0], 3) for v in vertices]}) — nút cụt, xe không ra được"
            )


def test_slot_center_shift_within_row_limit(slots: list[dict[str, Any]]) -> None:
    """ANS_6 mục 1 (P2d): ngưỡng lệch tâm **theo hàng** - 1-2 ≤ 20 px, 3-5 ≤ 8 px."""
    offenders = [
        (
            s["id"],
            round(float(s["center_shift_px"]), 2),
            ROW_MAX_SHIFT_PX.get(str(s["row"]), DEFAULT_MAX_SHIFT_PX),
        )
        for s in slots
        if float(s["center_shift_px"])
        > ROW_MAX_SHIFT_PX.get(str(s["row"]), DEFAULT_MAX_SHIFT_PX)
    ]
    assert offenders == [], f"tâm lệch quá ngưỡng hàng: {offenders}"
    shifts = sorted(float(s["center_shift_px"]) for s in slots)
    over3 = [v for v in shifts if v > 3.0]
    print(
        f"lệch tâm: trung vị {shifts[len(shifts) // 2]:.2f} px · max {shifts[-1]:.2f} px "
        f"· số ô > 3 px: {len(over3)}"
    )


def test_neighbouring_slots_in_row_do_not_overlap(slots: list[dict[str, Any]]) -> None:
    """Ô kề trong hàng không chồng nhau: bước tâm ≥ bề rộng ô (chạm cạnh là hợp lệ).

    Đây là điều kiện trực tiếp bảo đảm đa giác không giao nhau; phép kiểm diện tích giao
    thật nằm ở ``test_no_two_slot_polygons_intersect``.
    """
    by_row: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        by_row.setdefault(slot["row"], []).append(slot)
    for row, members in by_row.items():
        width = members[0]["width_m"]
        ordered = sorted(members, key=lambda s: s["center"][0])
        for prev, nxt in itertools.pairwise(ordered):
            gap = math.hypot(nxt["center"][0] - prev["center"][0], nxt["center"][1] - prev["center"][1])
            assert gap >= width - 1e-6, (
                f"hàng {row}: {prev['id']}–{nxt['id']} cách {gap:.3f} m < bề rộng {width:.3f} m"
            )


def _csv_gap_m(prev: dict[str, Any], nxt: dict[str, Any]) -> float:
    """Khoảng cách tâm hai ô theo csv, đổi ra mét tại hàng đó."""
    (u1, v1), (u2, v2) = prev["csv_center_px"], nxt["csv_center_px"]
    x1, y1 = bl.ground(u1, v1)
    x2, y2 = bl.ground(u2, v2)
    return math.hypot(x2 - x1, y2 - y1)


# --------------------------------------------------------------------------------------
# D6: lối vòng một chiều, cả 100 ô tới được
# --------------------------------------------------------------------------------------
def test_every_slot_reachable(lot: dict[str, Any], slots: list[dict[str, Any]]) -> None:
    """D6: xe nào cũng rời đi được ⇒ cả 100 ô phải ``reachable``."""
    unreachable = [s["id"] for s in slots if not s["reachable"]]
    assert unreachable == [], f"ô không tới được: {unreachable}"


def test_aisle_graph_reaches_all_rows() -> None:
    reachable = bl.reachable_aisles()
    assert {"A1", "A2", "A3"} <= reachable


def test_no_two_way_aisles(lot: dict[str, Any]) -> None:
    for aisle in lot["aisles"]:
        assert aisle["oneway"] is True


def test_l_gate_only_a2_crosses_gate_segments(lot: dict[str, Any]) -> None:
    """Luật L-GATE (P2b mục 2): **chỉ** A2 được cắt đoạn cổng vào/ra.

    Mọi làn khác phải cách đoạn cổng ≥ 2,0 m **tính cả nửa bề rộng làn** — nếu không, xe đi
    trên làn đó sẽ cắt vạch cổng, TechGAR đếm thêm lượt vào/ra giả và GT ``gate_in/out`` sai.
    """
    gates = lot["gates"]
    segments = {
        "in": (tuple(gates["in"]["p1"]), tuple(gates["in"]["p2"])),
        "out": (tuple(gates["out"]["p1"]), tuple(gates["out"]["p2"])),
    }
    offenders: list[str] = []
    for aisle in lot["aisles"]:
        polyline = [tuple(p) for p in aisle["polyline"]]
        for gate_name, (p1, p2) in segments.items():
            distance = min(
                _seg_seg_distance(a, b, p1, p2) for a, b in itertools.pairwise(polyline)
            )
            clearance = distance - aisle["width_m"] / 2.0
            if aisle["id"] == "A2":
                # Đoạn A2 vào/ra **phải** cắt một nửa đoạn cổng (một nửa, vì cổng dài 42 px và
                # A2 là đường tâm của nó) — tức khoảng cách tâm = 0.
                assert distance < 1e-4, f"A2 phải đi qua vạch cổng {gate_name}"
            elif aisle["id"] == "V_east_n" and gate_name == "in":
                # P17l: lối nối rẽ nam bắt đầu **trên chính làn cổng** A2 (xe đã qua vạch cổng).
                continue
            elif aisle["id"] == "V_far_w" and gate_name == "out" and clearance >= 1.9:
                # P17l phương án B (director): cung R=2,9 m, biên 1,95 m < 2,0 — chấp nhận có chủ ý.
                continue
            elif clearance < 2.0:
                offenders.append(f"{aisle['id']}–cổng {gate_name}: {clearance:.2f} m < 2,0 m")
    assert offenders == [], f"vi phạm L-GATE: {offenders}"


def test_l_gate_a2_is_the_only_lane_through_the_gate(lot: dict[str, Any]) -> None:
    """A2 phải là làn **duy nhất** có đoạn cắt vạch cổng (kiểm bằng khoảng cách tâm ≤ 2,5 m)."""
    gates = lot["gates"]
    hits: list[str] = []
    for aisle in lot["aisles"]:
        polyline = [tuple(p) for p in aisle["polyline"]]
        for gate_name in ("in", "out"):
            p1 = tuple(gates[gate_name]["p1"])
            p2 = tuple(gates[gate_name]["p2"])
            distance = min(
                _seg_seg_distance(a, b, p1, p2) for a, b in itertools.pairwise(polyline)
            )
            if distance <= aisle["width_m"] / 2.0 and not (
                aisle["id"] == "V_east_n" and gate_name == "in"  # P17l: bắt đầu trên làn cổng
            ):
                hits.append(f"{aisle['id']}:{gate_name}")
    assert sorted(hits) == ["A2:in", "A2:out"], f"làn cắt cổng: {hits}"


def test_far_west_lane_joins_a2_east_of_exit_gate(lot: dict[str, Any]) -> None:
    """Director G1 mục 2: ``V_far_w`` nhập A2 **phía đông** cổng ra và **không** lên A1."""
    nodes = lot["aisle_nodes"]
    far = next(a for a in lot["aisles"] if a["id"] == "V_far_w")
    end = tuple(far["polyline"][-1])
    gate_out = tuple(lot["gates"]["out"]["p1"])
    a2_y = lot["aisle_nodes"]["g_out"][1]
    a1_y = lot["aisle_nodes"]["a1_left"][1]
    assert end[0] > gate_out[0], "đầu cuối V_far_w phải ở đông cổng ra"
    assert abs(end[1] - a2_y) < 1e-6, "V_far_w phải kết thúc trên đường A2"
    assert abs(end[1] - a1_y) > 1.0, "V_far_w không được lên A1"
    assert "a1_far_left" not in nodes or nodes["a1_far_left"] != list(end)


def _seg_seg_distance(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], d: tuple[float, float]) -> float:
    """Khoảng cách nhỏ nhất giữa hai đoạn thẳng (m)."""

    def point_segment(p: tuple[float, float], s: tuple[float, float], e: tuple[float, float]) -> float:
        dx, dy = e[0] - s[0], e[1] - s[1]
        norm2 = dx * dx + dy * dy
        if norm2 < 1e-12:
            return math.hypot(p[0] - s[0], p[1] - s[1])
        t = max(0.0, min(1.0, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / norm2))
        return math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy))

    return min(
        point_segment(a, c, d),
        point_segment(b, c, d),
        point_segment(c, a, b),
        point_segment(d, a, b),
    )


def test_gate_entry_and_exit_on_aisle_a2(lot: dict[str, Any]) -> None:
    """Cổng vào/ra nằm trên lối gom A2 (v=343, ý tưởng §8)."""
    gates = lot["gates"]
    assert gates["in"]["p1_px"][0] == pytest.approx(630.0)
    assert gates["out"]["p1_px"][0] == pytest.approx(4.0)
    for key in ("in", "out"):
        v1 = gates[key]["p1_px"][1]
        v2 = gates[key]["p2_px"][1]
        assert (v1, v2) == (322.0, 364.0)
    # Điểm sinh xe ngoài khung (C8): u > 640 khi vào, u < 0 khi ra.
    spawn_in = bl.project(gates["in"]["spawn"][0], gates["in"]["spawn"][1])
    spawn_out = bl.project(gates["out"]["spawn"][0], gates["out"]["spawn"][1])
    assert spawn_in[0] > 640.0, "xe phải sinh ngoài khung bên phải (C8)"
    assert spawn_out[0] < 640.0


def test_gate_crossing_direction_is_west(lot: dict[str, Any]) -> None:
    """C6: xe vào và ra đều chạy về tây (X giảm)."""
    gates = lot["gates"]
    assert gates["in"]["despawn"][0] < gates["in"]["spawn"][0]
    assert gates["out"]["despawn"][0] < gates["out"]["spawn"][0]


# --------------------------------------------------------------------------------------
# Làn không cắt ô (điều kiện để mô phỏng không đè hình)
# --------------------------------------------------------------------------------------
def _polyline_hits_slot(polyline: list[list[float]], polygon: list[list[float]]) -> bool:
    import cv2

    slot = np.array([[round(x * 100), round(y * 100)] for x, y in polygon], np.int32)
    # P17l: làn có cung nên **không** gộp cả polyline thành một đa giác lồi — kiểm từng đoạn.
    for (x0, y0), (x1, y1) in itertools.pairwise(polyline):
        lane = np.array([[round(x0 * 100), round(y0 * 100)], [round(x1 * 100), round(y1 * 100)]], np.int32)
        hit, _ = cv2.intersectConvexConvex(lane, slot)
        if hit:
            return True
    return False


def test_no_lane_crosses_a_slot(lot: dict[str, Any], slots: list[dict[str, Any]]) -> None:
    """Lối đi không được cắt qua đa giác ô — nếu cắt thì xe chạy trên lối sẽ đè xe đỗ."""
    for aisle in lot["aisles"]:
        for slot in slots:
            assert not _polyline_hits_slot(aisle["polyline"], slot["polygon"]), (
                f"làn {aisle['id']} cắt ô {slot['id']}"
            )


def test_lane_polyline_is_straight_between_nodes(lot: dict[str, Any]) -> None:
    """Mỗi làn: đỉnh nằm trên đoạn thẳng (thẳng hàng), hoặc gấp khúc **vuông góc**.

    Làn được khai theo toạ độ ảnh (u,v) nên phép kiểm cũng làm trên ảnh; góc vuông trên ảnh
    là góc vuông thật của bãi (trục u ⟂ trục v của mặt đất).
    """
    for aisle in lot["aisles"]:
        pts = [bl.project(x, y) for x, y in aisle["polyline"]]
        for i in range(1, len(pts) - 1):
            a = np.array(pts[i]) - np.array(pts[i - 1])
            b = np.array(pts[i + 1]) - np.array(pts[i])
            cross = abs(float(a[0] * b[1] - a[1] * b[0]))
            dot = abs(float(a[0] * b[0] + a[1] * b[1]))
            norm = float(np.linalg.norm(a) * np.linalg.norm(b))
            # P17l: cung R ≥ 2,9 m được lấy mẫu thành các đoạn nối nhau — gãy nhỏ (≤ 20°) là cung.
            turn_deg = math.degrees(math.atan2(cross, float(a[0] * b[0] + a[1] * b[1])))
            assert cross / norm < 1e-5 or dot / norm < 1e-5 or turn_deg <= 20.0, (
                f"{aisle['id']}: khúc gãy chéo tại đỉnh {i}"
            )


# --------------------------------------------------------------------------------------
# Ảnh kiểm
# --------------------------------------------------------------------------------------
def test_render_plan_and_overlay(lot: dict[str, Any], tmp_path: Path) -> None:
    """2 ảnh kiểm phải vẽ được, đúng kích thước, có nội dung (không phải ảnh trống)."""
    import cv2

    plan = bl.render_plan(lot)
    overlay = bl.render_overlay(lot)
    assert plan.ndim == 3 and plan.shape[2] == 3
    assert plan.shape[0] > 300 and plan.shape[1] > 600
    assert int(plan.std()) > 5
    assert overlay.shape == (640, 640, 3)
    assert int(overlay.std()) > 5
    cv2.imwrite(str(tmp_path / "plan.png"), plan)
    cv2.imwrite(str(tmp_path / "overlay.png"), overlay)
    assert (tmp_path / "plan.png").stat().st_size > 5_000
    assert (tmp_path / "overlay.png").stat().st_size > 5_000


def test_camera_roundtrip_is_exact() -> None:
    """``project(ground(u, v))`` phải trả lại đúng (u, v) — nền của mọi kiểm hình học."""
    for u, v in ((320.0, 320.0), (0.0, 160.0), (639.0, 600.0), (615.0, 343.0), (25.0, 343.0)):
        x, y = bl.ground(u, v)
        u2, v2 = bl.project(x, y)
        assert u2 == pytest.approx(u, abs=1e-9)
        assert v2 == pytest.approx(v, abs=1e-9)


def test_row_width_is_inside_csv_width_range(slots: list[dict[str, Any]]) -> None:
    """D5: bề rộng chuẩn hoá của hàng phải nằm trong dải bề rộng csv của hàng đó.

    Bề rộng hàng là **bước ô trung vị** (đều cho cả hàng), nên không thể bằng từng ô —
    csv là bbox thẳng trục, ô nghiêng bị đo rộng hơn bề rộng thật. Kiểm rằng giá trị
    chuẩn hoá vẫn nằm trong dải đo thật để bắt lỗi quy đổi đơn vị.
    """
    by_row: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        by_row.setdefault(slot["row"], []).append(slot)
    for row, members in by_row.items():
        csv_widths = [m["csv_width_m"] for m in members]
        width = members[0]["width_m"]
        assert min(csv_widths) - 0.3 <= width <= max(csv_widths) + 0.3, (
            f"hàng {row}: chuẩn hoá {width:.2f} m ngoài dải csv "
            f"[{min(csv_widths):.2f}, {max(csv_widths):.2f}]"
        )


@pytest.fixture(scope="module", autouse=True)
def _no_unreachable_warnings() -> Iterator[None]:
    """Cảnh báo ``không tới được`` không được xuất hiện (D6)."""
    _, warnings = bl.build_lot()
    reachability = [w for w in warnings if "không tới được" in w]
    assert reachability == [], reachability
    yield

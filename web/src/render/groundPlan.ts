/**
 * Hình học mặt bãi cho render (P4b): cắt cỏ khỏi lòng làn, vạch cổng, ô trang trí.
 *
 * **Thuần dữ liệu** (không three, không DOM) nên test bằng Node được.
 *
 * Lý do tồn tại: `lot_pucpr.json` (P2c) vẽ dải cỏ chạy **xuyên qua** 4 làn dọc
 * (`V_west`, `V_east`, `V_east_s`, `V_far_w`). Sửa dữ liệu là việc của `build_lot.py`
 * (ngoài quyền P4b), nên tầng render cắt cỏ theo lòng làn — nếu để nguyên thì cỏ nằm
 * giữa đường xe chạy, sai cả hình lẫn ý nghĩa "đường nhựa".
 */

import type { LotMap, Vec2 } from '../contracts/lot';

/** Lòng một làn: đa giác 4 góc (đã mở rộng bằng nửa bề rộng) + id. */
export interface AisleCorridor {
  readonly id: string;
  readonly quad: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly widthM: number;
}

/** Diện tích đa giác (shoelace), luôn dương. */
export function polygonArea(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Trung bình 4 góc — đủ để lấy một điểm "đại diện" nằm trong đa giác lồi. */
export function polygonCentroid(polygon: readonly Vec2[]): Vec2 {
  if (polygon.length === 0) {
    throw new Error('polygonCentroid: đa giác rỗng');
  }
  let sx = 0;
  let sy = 0;
  for (const [x, y] of polygon) {
    sx += x;
    sy += y;
  }
  return [sx / polygon.length, sy / polygon.length];
}

/** Điểm nằm trong đa giác (ray casting) — dùng cho test và cho mask. */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let index = 0, prev = polygon.length - 1; index < polygon.length; prev = index, index += 1) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[prev];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Lòng của mọi làn (mỗi đoạn polyline một hình bình hành).
 *
 * Mở rộng thêm `paddingM` mỗi bên để mép cỏ không chạm vạch làn (nhìn sạch hơn, và tránh
 * z-fighting ở mép).
 */
export function aisleCorridors(lot: LotMap, paddingM = 0.15): readonly AisleCorridor[] {
  const corridors: AisleCorridor[] = [];
  for (const aisle of lot.aisles) {
    const half = aisle.width_m / 2 + paddingM;
    const points = aisle.polyline;
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) {
        continue;
      }
      const nx = (-dy / length) * half;
      const ny = (dx / length) * half;
      corridors.push({
        id: `${aisle.id}#${String(index)}`,
        widthM: aisle.width_m,
        quad: [
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny],
        ],
      });
    }
  }
  return corridors;
}

/**
 * Cắt đa giác bằng nửa mặt phẳng xác định bởi `a → b`, giữ phía có `signedDist >= 0`.
 *
 * `side = +1` giữ phía **trái** của `a → b`, `side = -1` giữ phía **phải**.
 * Sutherland–Hodgman, đúng cho đa giác lồi (mọi đa giác ở đây đều lồi).
 */
export function clipHalfPlane(
  polygon: readonly Vec2[],
  a: Vec2,
  b: Vec2,
  side: 1 | -1,
): Vec2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) {
    throw new Error('clipHalfPlane: hai điểm trùng nhau, không xác định được nửa mặt phẳng');
  }
  // Pháp tuyến phía trái của a→b là (-dy, dx).
  const nx = (-dy / length) * side;
  const ny = (dx / length) * side;
  const signed = (point: Vec2): number => (point[0] - a[0]) * nx + (point[1] - a[1]) * ny;

  const output: Vec2[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const dCurrent = signed(current);
    const dNext = signed(next);
    const currentInside = dCurrent >= 0;
    const nextInside = dNext >= 0;
    if (currentInside) {
      output.push(current);
    }
    if (currentInside !== nextInside) {
      const ratio = dCurrent / (dCurrent - dNext);
      output.push([
        current[0] + (next[0] - current[0]) * ratio,
        current[1] + (next[1] - current[1]) * ratio,
      ]);
    }
  }
  return output;
}

/**
 * Dấu định hướng đa giác: `+1` nếu cùng chiều kim đồng hồ (CCW trong hệ y-up), `-1` nếu ngược.
 * Với đa giác CCW thì "phía trong" là phía **trái** của mỗi cạnh `a→b`.
 */
export function polygonOrientation(polygon: readonly Vec2[]): 1 | -1 {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum >= 0 ? 1 : -1;
}

/**
 * Trừ một đa giác **lồi** `cut` khỏi đa giác **lồi** `polygon`.
 *
 * Công thức "bậc thang" (staircase, chuẩn, không chồng mảnh):
 *
 *     P \ R = ¬H₀ ∪ (H₀ ∩ ¬H₁) ∪ (H₀ ∩ H₁ ∩ ¬H₂) ∪ …
 *
 * với `Hᵢ` là nửa mặt phẳng **trong** của cạnh thứ `i` của `R`. Mỗi mảnh nằm ngoài đúng
 * một cạnh và nằm trong mọi cạnh **trước** nó ⇒ các mảnh rời nhau, tổng diện tích đúng
 * bằng `P \ R`. Số mảnh tuyến tính theo số cạnh (không nổ 2^n như De Morgan thuần —
 * đã thử với 12 vết cắt và vitest hết bộ nhớ).
 */
export function subtractConvex(
  polygon: readonly Vec2[],
  cut: readonly Vec2[],
): readonly (readonly Vec2[])[] {
  if (cut.length < 3) {
    return [polygon];
  }
  // `insideSign = +1` nghĩa là phía **trái** của `a→b` là phía trong (đa giác CCW).
  const insideSign = polygonOrientation(cut);
  const pieces: Vec2[][] = [];

  // `remaining` = phần của P còn nằm trong mọi cạnh đã xét (H₀∩…∩Hᵢ₋₁).
  let remaining: Vec2[] = [...polygon];
  for (let index = 0; index < cut.length; index += 1) {
    if (remaining.length < 3) {
      break;
    }
    const a = cut[index];
    const b = cut[(index + 1) % cut.length];
    // ¬Hᵢ: phần **ngoài** cạnh i, cắt từ `remaining`.
    const outside = clipHalfPlane(remaining, a, b, insideSign === 1 ? -1 : 1);
    if (outside.length >= 3 && polygonArea(outside) > 1e-6) {
      pieces.push(outside);
    }
    // Rồi thu `remaining` về phía trong cạnh i để vòng sau không sinh lại phần đã lấy.
    remaining = clipHalfPlane(remaining, a, b, insideSign);
  }
  return pieces;
}

/**
 * Cắt toàn bộ cỏ khỏi lòng các làn.
 *
 * Trả danh sách mảnh cỏ vẽ được (đã bỏ phần giao với làn). Mảnh quá nhỏ (< 0,5 m²) bị bỏ
 * để không sinh mesh rác.
 */
export function grassOutsideAisles(
  lot: LotMap,
  corridors: readonly AisleCorridor[] = aisleCorridors(lot),
): readonly (readonly Vec2[])[] {
  const pieces: (readonly Vec2[])[] = [];
  for (const grass of lot.decor.grass) {
    let pending: (readonly Vec2[])[] = [grass];
    for (const corridor of corridors) {
      const next: (readonly Vec2[])[] = [];
      for (const polygon of pending) {
        const remains = subtractConvex(polygon, corridor.quad);
        for (const piece of remains) {
          if (polygonArea(piece) >= 0.5) {
            next.push(piece);
          }
        }
      }
      pending = next;
      if (pending.length === 0) {
        break;
      }
    }
    pieces.push(...pending);
  }
  return pieces;
}

/** Cỏ còn giao làn không (test dùng). */
export function grassTouchesAisle(
  lot: LotMap,
  corridors: readonly AisleCorridor[] = aisleCorridors(lot),
): readonly { readonly corridorId: string; readonly point: Vec2 }[] {
  const hits: { corridorId: string; point: Vec2 }[] = [];
  for (const piece of grassOutsideAisles(lot, corridors)) {
    for (const corridor of corridors) {
      for (const corner of piece) {
        if (pointInPolygon(corner, corridor.quad)) {
          hits.push({ corridorId: corridor.id, point: corner });
          break;
        }
      }
    }
  }
  return hits;
}

/** Giao của hai đa giác lồi (dùng cho test "cỏ chồng làn"). */
export function intersectConvex(a: readonly Vec2[], b: readonly Vec2[]): readonly Vec2[] {
  const insideSign = polygonOrientation(b);
  let current: Vec2[] = [...a];
  for (let index = 0; index < b.length; index += 1) {
    if (current.length < 3) {
      return [];
    }
    const p = b[index];
    const q = b[(index + 1) % b.length];
    current = clipHalfPlane(current, p, q, insideSign);
  }
  return current;
}

/** Vạch cổng: dải sơn ngang qua đoạn cổng, dày `thicknessM`. */
export interface GateMarking {
  readonly kind: 'in' | 'out';
  readonly quad: readonly [Vec2, Vec2, Vec2, Vec2];
}

/**
 * Vạch sơn cho hai cổng (task P4b mục 1: "vạch cổng").
 *
 * Lấy đúng `lot.gates.in/out` (nguồn sự thật) — **không** hard-code `u`, vì P2c đã dời cổng
 * (vào `u=630`, ra `u=4`) so với con số trong TASK (`u=22`).
 */
export function gateMarkings(lot: LotMap, thicknessM = 0.45): readonly GateMarking[] {
  const build = (kind: 'in' | 'out', p1: Vec2, p2: Vec2): GateMarking => {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) {
      throw new Error(`gateMarkings: cổng ${kind} có hai điểm trùng nhau`);
    }
    // Pháp tuyến = hướng qua cổng; dải sơn dày `thicknessM` theo hướng đó.
    const nx = (-dy / length) * (thicknessM / 2);
    const ny = (dx / length) * (thicknessM / 2);
    return {
      kind,
      quad: [
        [p1[0] + nx, p1[1] + ny],
        [p2[0] + nx, p2[1] + ny],
        [p2[0] - nx, p2[1] - ny],
        [p1[0] - nx, p1[1] - ny],
      ],
    };
  };
  return [build('in', lot.gates.in.p1, lot.gates.in.p2), build('out', lot.gates.out.p1, lot.gates.out.p2)];
}

/**
 * Ô **trang trí** (task P4b mục 1: "11 ô trang trí (vạch, KHÔNG xe)").
 *
 * P2c nhét 11 ô này vào `decor.asphalt` (mỗi ô ~40 m²) và dùng `decor.curbs` làm nét vạch,
 * vì `contracts/lot.ts` chưa có kiểu "ô trang trí". Hàm này tách chúng ra khỏi nền đường
 * bằng ngưỡng diện tích, để render vẽ **vạch phẳng** thay vì bê-tông nổi, và để test chứng
 * minh chúng không nằm trong `slots`.
 */
export interface DecorStall {
  readonly quad: readonly Vec2[];
  readonly areaM2: number;
}

/** Ngưỡng diện tích để coi một đa giác `asphalt` là ô trang trí (m²). */
export const DECOR_STALL_MAX_AREA_M2 = 120;

/** Tách các ô trang trí khỏi nền đường của `decor.asphalt`. */
export function decorStalls(lot: LotMap): readonly DecorStall[] {
  return lot.decor.asphalt
    .map((quad) => ({ quad, areaM2: polygonArea(quad) }))
    .filter((entry) => entry.areaM2 <= DECOR_STALL_MAX_AREA_M2);
}

/** Nền đường thật (đa giác lớn), đã bỏ các ô trang trí. */
export function roadPolygons(lot: LotMap): readonly (readonly Vec2[])[] {
  return lot.decor.asphalt.filter(
    (quad) => polygonArea(quad) > DECOR_STALL_MAX_AREA_M2,
  );
}

/**
 * Ô trang trí có nằm ngoài mọi ô thật không (task P4b: "không vào slots/GT").
 * Trả danh sách ô trang trí **vi phạm** (rỗng là đạt).
 */
export function decorStallsInsideSlots(lot: LotMap): readonly Vec2[] {
  const violations: Vec2[] = [];
  for (const stall of decorStalls(lot)) {
    const center = polygonCentroid(stall.quad);
    const inside = lot.slots.some((slot) => pointInPolygon(center, slot.polygon));
    if (inside) {
      violations.push(center);
    }
  }
  return violations;
}

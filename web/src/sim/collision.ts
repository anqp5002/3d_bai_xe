/**
 * Kiểm chồng hình chữ nhật xe mỗi frame (FE §4.4.4) + hình học dùng chung.
 *
 * Xe là hình chữ nhật có hướng (SAT). Chạm cạnh (penetration = 0) **không** tính là
 * chồng; chỉ báo khi hai hình xuyên nhau thật, tránh cảnh báo giả khi xe vừa khít.
 *
 * Đây là lỗi lập trình nếu xảy ra: `findCollisions` trả cảnh báo `kind: 'collision'`
 * để UI dừng mô phỏng và log — không bao giờ im lặng (R2).
 */

import type { Vec2 } from '../contracts/lot';
import type { CarState, Warning } from '../contracts/sim';

/**
 * Dung sai tiếp xúc, m (ANS_11): xuyên ≤ ngưỡng này là **chạm cạnh** do sai số tích phân, không
 * phải va chạm. 1 cm ≈ 0,08 px ở camera dataset (1 px ≈ 0,13 m) và nhỏ hơn một bước đi
 * (≈ 0,11 m/frame ở 10 km/h). Xuyên **vượt** ngưỡng thì vẫn là va chạm và bước đi bị chặn, nên
 * độ xuyên không thể tích luỹ quá ngưỡng. Đây là hằng số DUY NHẤT cho kiểm va chạm của sim.
 */
export const CONTACT_TOLERANCE_M = 0.01;

/** Hai hình coi là chồng khi xuyên nhau quá ngưỡng này, m (= :data:`CONTACT_TOLERANCE_M`). */
export const COLLISION_EPS_M = CONTACT_TOLERANCE_M;

export interface OrientedRect {
  readonly center: Vec2;
  /** Góc hướng trục dọc (mũi xe), rad. */
  readonly heading: number;
  readonly length: number;
  readonly width: number;
}

export type RectCorners = readonly [Vec2, Vec2, Vec2, Vec2];

/** Hình chữ nhật của một xe theo trạng thái hiện tại. */
export function carRect(car: CarState): OrientedRect {
  return {
    center: [car.pose.x, car.pose.y],
    heading: car.pose.th,
    length: car.length,
    width: car.width,
  };
}

/** Bốn góc theo thứ tự: trước-trái, trước-phải, sau-phải, sau-trái. */
export function rectCorners(rect: OrientedRect): RectCorners {
  const cos = Math.cos(rect.heading);
  const sin = Math.sin(rect.heading);
  const halfLength = rect.length / 2;
  const halfWidth = rect.width / 2;
  const forward: Vec2 = [cos, sin];
  const side: Vec2 = [-sin, cos];
  const corner = (forwardSign: number, sideSign: number): Vec2 => [
    rect.center[0] + forward[0] * halfLength * forwardSign + side[0] * halfWidth * sideSign,
    rect.center[1] + forward[1] * halfLength * forwardSign + side[1] * halfWidth * sideSign,
  ];
  return [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
}

function projectOnAxis(corners: RectCorners, axis: Vec2): readonly [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const value = corner[0] * axis[0] + corner[1] * axis[1];
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/** Hai hình chữ nhật có hướng xuyên nhau? (SAT, bỏ qua chạm cạnh) */
export function rectsOverlap(
  a: OrientedRect,
  b: OrientedRect,
  epsilon: number = COLLISION_EPS_M,
): boolean {
  return penetrationDepth(a, b) > epsilon;
}

/**
 * Độ sâu xuyên giữa hai hình chữ nhật có hướng theo SAT, m.
 *
 * Trả `0` khi hai hình không xuyên nhau (chạm cạnh cũng là 0). Ngược lại trả **độ sâu nhỏ
 * nhất** trên 4 trục tách — tức "cần đẩy ra bao xa để hết chồng", đúng định nghĩa độ xuyên
 * dùng cho ngưỡng `PARK_CLIP_MAX_DEPTH_M` của ANS_4.
 */
export function penetrationDepth(a: OrientedRect, b: OrientedRect): number {
  if (!(a.length > 0) || !(a.width > 0) || !(b.length > 0) || !(b.width > 0)) {
    throw new Error('penetrationDepth: kích thước hình chữ nhật phải > 0');
  }
  const cornersA = rectCorners(a);
  const cornersB = rectCorners(b);
  const axes: readonly Vec2[] = [
    [Math.cos(a.heading), Math.sin(a.heading)],
    [-Math.sin(a.heading), Math.cos(a.heading)],
    [Math.cos(b.heading), Math.sin(b.heading)],
    [-Math.sin(b.heading), Math.cos(b.heading)],
  ];
  let smallest = Number.POSITIVE_INFINITY;
  for (const axis of axes) {
    const [minA, maxA] = projectOnAxis(cornersA, axis);
    const [minB, maxB] = projectOnAxis(cornersB, axis);
    // Khoảng hở có dấu trên trục này: > 0 = tách, < 0 = xuyên.
    const gap = Math.max(minB - maxA, minA - maxB);
    if (gap >= 0) {
      return 0;
    }
    smallest = Math.min(smallest, -gap);
  }
  return smallest;
}

/** Một cặp xe chồng nhau, kèm độ sâu xuyên (m) để bên gọi quyết định dung sai. */
export interface CollisionPair {
  readonly a: CarState;
  readonly b: CarState;
  readonly depth_m: number;
}

/**
 * Mọi cặp xe chồng nhau trong một frame (dùng nội bộ cho engine, nơi cần độ sâu để áp
 * dung sai `park_clip`). Thứ tự cặp (i, j) tất định.
 */
export function findCollisionPairs(cars: readonly CarState[]): readonly CollisionPair[] {
  const pairs: CollisionPair[] = [];
  for (let i = 0; i < cars.length; i += 1) {
    for (let j = i + 1; j < cars.length; j += 1) {
      const a = cars[i];
      const b = cars[j];
      const depth = penetrationDepth(carRect(a), carRect(b));
      if (depth > COLLISION_EPS_M) {
        pairs.push({ a, b, depth_m: depth });
      }
    }
  }
  return pairs;
}

/** Mọi cặp xe chồng nhau trong một frame, theo thứ tự cặp (i, j) tất định. */
export function findCollisions(
  cars: readonly CarState[],
  frame: number,
): readonly Warning[] {
  const warnings: Warning[] = [];
  for (const pair of findCollisionPairs(cars)) {
    warnings.push({
      frame,
      kind: 'collision',
      message: `${pair.a.id} chồng ${pair.b.id} — lỗi lập trình, tạm dừng mô phỏng (FE §4.4.4)`,
      car_id: pair.a.id,
    });
  }
  return warnings;
}

/** Điểm nằm trong đa giác đơn (ray casting). Biên không tính là trong. */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  if (polygon.length < 3) {
    return false;
  }
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = yi > y !== yj > y;
    if (!straddles) {
      continue;
    }
    const cut = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < cut) {
      inside = !inside;
    }
  }
  return inside;
}

function cross(origin: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function onSegment(a: Vec2, b: Vec2, point: Vec2): boolean {
  return (
    Math.min(a[0], b[0]) <= point[0] &&
    point[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= point[1] &&
    point[1] <= Math.max(a[1], b[1])
  );
}

/** Hai đoạn thẳng cắt nhau (kể cả chạm đầu mút/thẳng hàng). */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(b1, b2, a1)) {
    return true;
  }
  if (d2 === 0 && onSegment(b1, b2, a2)) {
    return true;
  }
  if (d3 === 0 && onSegment(a1, a2, b1)) {
    return true;
  }
  if (d4 === 0 && onSegment(a1, a2, b2)) {
    return true;
  }
  return false;
}

/** Hai đa giác đơn giao nhau (cạnh cắt nhau hoặc đỉnh lọt trong đa giác kia). */
export function polygonsIntersect(
  a: readonly Vec2[],
  b: readonly Vec2[],
): boolean {
  if (a.length < 3 || b.length < 3) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) {
        return true;
      }
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

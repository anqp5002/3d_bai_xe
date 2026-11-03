/**
 * Hình học phẳng dùng chung cho đường đi, đặt chỗ và kiểm L-GATE (FE §3, §4.3).
 *
 * Tất cả hàm là thuần dữ liệu, đơn vị mét / radian, hệ world của `ground()`
 * (X sang phải, Y ra xa camera). Không hard-code tên làn hay ô.
 */

import type { Vec2 } from '../contracts/lot';

/** Sao chép một điểm (tránh chia sẻ tham chiếu giữa các trạng thái). */
export function clonePoint(point: Vec2): Vec2 {
  return [point[0], point[1]];
}

/** Làm tròn trạng thái 1e-6 m sau mỗi bước (D11) — không trả -0. */
export function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Kẹp `value` vào [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Chuẩn hoá góc về (−π, π]. */
export function normalizeAngle(angle: number): number {
  let result = angle % (2 * Math.PI);
  if (result <= -Math.PI) {
    result += 2 * Math.PI;
  }
  if (result > Math.PI) {
    result -= 2 * Math.PI;
  }
  return result;
}

/** Khoảng cách Euclid hai điểm, m. */
export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Điểm trên đoạn a→b gần `point` nhất (tham số đã kẹp trong [0, 1]). */
export function nearestPointOnSegment(a: Vec2, b: Vec2, point: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) {
    return a;
  }
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq, 0, 1);
  return [a[0] + dx * t, a[1] + dy * t];
}

/** Khoảng cách điểm → đoạn thẳng, m. */
export function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  return distance(point, nearestPointOnSegment(a, b, point));
}

/** Khoảng cách hai đoạn thẳng (0 nếu cắt nhau), m. */
export function segmentSegmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

/** Tổng chiều dài polyline, m. */
export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

/** Kết quả lấy điểm theo quãng đường dọc polyline. */
export interface PointAtDistance {
  readonly point: Vec2;
  /** Hướng đi tiếp trên polyline tại điểm này, rad (0 = +X). */
  readonly heading: number;
  /** Chỉ số đoạn chứa điểm (đoạn `index` nối `points[index]` → `points[index + 1]`). */
  readonly index: number;
}

/**
 * Điểm cách đầu polyline `s` mét (kẹp trong [0, length]).
 * `heading` là hướng tăng `s`, kể cả khi xe đang lùi (xe quay mũi ngược lại).
 */
export function pointAtDistance(
  points: readonly Vec2[],
  s: number,
): PointAtDistance {
  if (points.length === 0) {
    throw new Error('pointAtDistance: polyline rỗng');
  }
  if (points.length === 1) {
    return { point: points[0], heading: 0, index: 0 };
  }
  let remaining = Math.max(0, s);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const segmentLength = distance(a, b);
    if (remaining <= segmentLength || index === points.length - 1) {
      const t = segmentLength <= 0 ? 0 : clamp(remaining / segmentLength, 0, 1);
      return {
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        heading: segmentLength <= 0 ? 0 : Math.atan2(b[1] - a[1], b[0] - a[0]),
        index,
      };
    }
    remaining -= segmentLength;
  }
  const last = points[points.length - 1];
  return { point: last, heading: 0, index: points.length - 1 };
}

/** Hình chiếu của một điểm lên polyline. */
export interface PolylineProjection {
  /** Quãng đường dọc polyline tới hình chiếu, m. */
  readonly distance_along: number;
  /** Khoảng cách vuông góc tới polyline, m. */
  readonly lateral: number;
  /** Hướng đi tiếp của polyline tại hình chiếu, rad. */
  readonly heading: number;
  readonly point: Vec2;
  readonly index: number;
}

/** Chiếu `point` lên polyline, trả hình chiếu gần nhất. */
export function projectOnPolyline(
  points: readonly Vec2[],
  point: Vec2,
): PolylineProjection {
  if (points.length === 0) {
    throw new Error('projectOnPolyline: polyline rỗng');
  }
  if (points.length === 1) {
    return {
      distance_along: 0,
      lateral: distance(points[0], point),
      heading: 0,
      point: points[0],
      index: 0,
    };
  }
  let best: PolylineProjection = {
    distance_along: 0,
    lateral: Number.POSITIVE_INFINITY,
    heading: 0,
    point: points[0],
    index: 0,
  };
  let cumulative = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const nearest = nearestPointOnSegment(a, b, point);
    const lateral = distance(nearest, point);
    if (lateral < best.lateral) {
      const segmentLength = distance(a, b);
      best = {
        distance_along: cumulative + distance(a, nearest),
        lateral,
        heading: segmentLength <= 0 ? 0 : Math.atan2(b[1] - a[1], b[0] - a[0]),
        point: nearest,
        index,
      };
    }
    cumulative += distance(a, b);
  }
  return best;
}

/** Bao lồi (Andrew monotone chain) của tập điểm, bỏ điểm trùng/ thẳng hàng thừa. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  if (points.length < 3) {
    return [...points];
  }
  const sorted = [...points].sort((a, b) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] - b[0],
  );
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vec2[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Cung tròn từ `startAngle` quét `sweep` radian, chia `count` đoạn. */
export function arcPoints(
  center: Vec2,
  radius: number,
  startAngle: number,
  sweep: number,
  count: number,
): Vec2[] {
  if (!Number.isInteger(count) || count < 1 || !(radius > 0)) {
    throw new Error(
      `arcPoints: cần count ≥ 1 và radius > 0, nhận count=${String(count)}, radius=${String(radius)}`,
    );
  }
  const points: Vec2[] = [];
  for (let index = 0; index <= count; index += 1) {
    const angle = startAngle + (sweep * index) / count;
    points.push([
      round6(center[0] + radius * Math.cos(angle)),
      round6(center[1] + radius * Math.sin(angle)),
    ]);
  }
  return points;
}

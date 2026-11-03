/**
 * Động học xe đạp + bám đường (FE §4.3–§4.4, D7).
 *
 * Xe không trượt ngang, không xoay tại chỗ: mỗi bước điều khiển góc lái bằng
 * pure pursuit tới điểm nhìn trước trên lộ trình, rồi tích phân mô hình xe đạp.
 * Khi `gear = reverse` xe lùi đúng nghĩa (v âm), không phải quay đầu giả.
 *
 * Hàm thuần dữ liệu: nhận pose/v/route + tham số, trả pose/v/quãng đường mới.
 */

import type { Vec2 } from '../contracts/lot';
import type { Pose, Route } from '../contracts/sim';
import {
  clamp,
  distance,
  normalizeAngle,
  pointAtDistance,
  projectOnPolyline,
  round6,
} from './geometry';
import { MIN_GAP_M } from './follow';

/** Chiều dài cơ sở, m (giống `kinematics.py`). */
export const WHEELBASE_M = 2.7;
/** Góc lái tối đa, rad (35°). */
export const MAX_STEER_RAD = (35 * Math.PI) / 180;
/** Gia tốc/phanh mặc định, m/s² (FE §4.3). */
export const MAX_ACCEL_MPS2 = 1.5;
/** Khoảng nhìn trước mặc định, m. */
export const LOOKAHEAD_M = 1.8;
/** Khoảng nhìn trước nhỏ nhất, m (tránh chia 0). */
export const MIN_LOOKAHEAD_M = 0.5;
/** Dung sai coi là tới cuối lộ trình, m. */
export const ROUTE_END_EPS_M = 0.02;

/** Dãy vị trí tâm xe của lộ trình. */
export function routePositions(route: Route): Vec2[] {
  return route.points.map((point) => [point.pose.x, point.pose.y] as Vec2);
}

/** Quãng đường tích luỹ tới từng điểm của lộ trình, m. */
export function routeCumulative(route: Route): number[] {
  const cumulative = [0];
  for (let index = 1; index < route.points.length; index += 1) {
    const previous = route.points[index - 1].pose;
    const current = route.points[index].pose;
    cumulative.push(
      cumulative[index - 1] + Math.hypot(current.x - previous.x, current.y - previous.y),
    );
  }
  return cumulative;
}

/**
 * Chỉ số đoạn chứa `s` (đoạn `index` nối điểm `index` → `index + 1`).
 * Tại đúng mốc đổi số, trả đoạn **mới** để xe không kẹt ở vận tốc 0.
 */
export function routeSegmentIndex(cumulative: readonly number[], s: number): number {
  const last = cumulative.length - 2;
  if (last < 0) {
    return 0;
  }
  for (let index = 0; index < last; index += 1) {
    if (s < cumulative[index + 1] - 1e-9) {
      return index;
    }
  }
  return last;
}

/** Gear của đoạn chứa `s`. */
export function routeGearAt(route: Route, s: number): 'forward' | 'reverse' {
  const cumulative = routeCumulative(route);
  const index = routeSegmentIndex(cumulative, s);
  return route.points[index]?.gear ?? route.points[route.points.length - 1]?.gear ?? 'forward';
}

/** Tốc độ tối đa của đoạn chứa `s`, m/s. */
export function routeSpeedLimitAt(route: Route, s: number): number {
  const cumulative = routeCumulative(route);
  const index = routeSegmentIndex(cumulative, s);
  return route.points[index]?.v_max ?? 0;
}

/** Mốc giới hạn tốc độ kế tiếp trên lộ trình. */
interface SpeedBoundary {
  /** Quãng đường còn lại tới mốc, m. */
  readonly distance: number;
  /** Tốc độ cho phép tại mốc, m/s (0 = phải dừng để đổi số/kết thúc). */
  readonly speed: number;
}

/**
 * Mốc kế tiếp cần giảm tốc: đổi số (phải dừng) hoặc giảm `v_max`
 * (ví dụ từ tốc độ làn xuống 5 km/h khi vào ô).
 */
function nextSpeedBoundary(
  route: Route,
  cumulative: readonly number[],
  s: number,
): SpeedBoundary {
  const index = routeSegmentIndex(cumulative, s);
  const segment = route.points[index];
  if (segment === undefined) {
    return { distance: Math.max(0, route.length_m - s), speed: 0 };
  }
  for (let cursor = index + 1; cursor < route.points.length; cursor += 1) {
    const point = route.points[cursor];
    if (point.gear !== segment.gear) {
      return { distance: Math.max(0, cumulative[cursor] - s), speed: 0 };
    }
    if (point.v_max < segment.v_max - 1e-9) {
      return { distance: Math.max(0, cumulative[cursor] - s), speed: point.v_max };
    }
  }
  return { distance: Math.max(0, route.length_m - s), speed: 0 };
}

/** Trạng thái sau một bước tiến trên lộ trình. */
export interface DriveResult {
  readonly pose: Pose;
  /** Vận tốc có dấu, m/s (âm = lùi). */
  readonly v: number;
  /** Quãng đường đã đi trên lộ trình, m. */
  readonly route_s: number;
  readonly gear: 'forward' | 'reverse';
  /** Đã tới cuối lộ trình. */
  readonly finished: boolean;
}

/**
 * Một bước 0,04 s trên lộ trình.
 *
 * `targetSpeed` là trần vận tốc (đã gồm tốc độ mong muốn, bám xe, đặt chỗ);
 * hàm tự siết thêm để phanh kịp chỗ đổi số/cuối lộ trình.
 */
export function advanceAlongRoute(
  route: Route,
  routeS: number,
  pose: Pose,
  v: number,
  targetSpeed: number,
  dtS: number,
): DriveResult {
  if (!(dtS > 0)) {
    throw new Error(`advanceAlongRoute: dtS phải > 0, nhận ${String(dtS)}`);
  }
  const positions = routePositions(route);
  const cumulative = routeCumulative(route);
  const index = routeSegmentIndex(cumulative, routeS);
  const gear = route.points[index]?.gear ?? 'forward';
  const speedLimit = route.points[index]?.v_max ?? 0;
  const remaining = Math.max(0, route.length_m - routeS);
  const boundary = nextSpeedBoundary(route, cumulative, routeS);
  const stopDistance = Math.min(remaining, boundary.distance);
  const brakeSpeed = Math.sqrt(
    boundary.speed * boundary.speed +
      2 * MAX_ACCEL_MPS2 * Math.max(0, stopDistance - ROUTE_END_EPS_M),
  );
  const desired = clamp(Math.min(Math.max(0, targetSpeed), speedLimit, brakeSpeed), 0, speedLimit);

  let speed = Math.max(0, Math.abs(v));
  if (speed < desired) {
    speed = Math.min(speed + MAX_ACCEL_MPS2 * dtS, desired);
  } else {
    speed = Math.max(speed - MAX_ACCEL_MPS2 * dtS, desired);
  }
  if (stopDistance <= ROUTE_END_EPS_M && boundary.speed <= 1e-9) {
    speed = 0;
  }
  if (remaining <= ROUTE_END_EPS_M || (remaining <= 0.2 && speed < 0.2)) {
    const last = route.points[route.points.length - 1].pose;
    return {
      pose: { x: last.x, y: last.y, th: last.th },
      v: 0,
      route_s: route.length_m,
      gear,
      finished: true,
    };
  }

  const lookahead = Math.min(
    Math.max(LOOKAHEAD_M, MIN_LOOKAHEAD_M),
    Math.max(remaining, MIN_LOOKAHEAD_M),
  );
  const target = pointAtDistance(positions, Math.min(routeS + lookahead, route.length_m)).point;
  const direction = gear === 'forward' ? 1 : -1;
  const travelHeading = direction > 0 ? pose.th : pose.th + Math.PI;
  const bearing = Math.atan2(target[1] - pose.y, target[0] - pose.x);
  const alpha = normalizeAngle(bearing - travelHeading);
  const targetDistance = Math.max(distance([pose.x, pose.y], target), MIN_LOOKAHEAD_M);
  let steer = clamp(
    Math.atan2(2 * WHEELBASE_M * Math.sin(alpha), targetDistance),
    -MAX_STEER_RAD,
    MAX_STEER_RAD,
  );
  if (direction < 0) {
    steer = -steer;
  }

  if (speed <= 0) {
    return { pose, v: 0, route_s: routeS, gear, finished: remaining <= ROUTE_END_EPS_M };
  }

  const x = pose.x + direction * speed * Math.cos(pose.th) * dtS;
  const y = pose.y + direction * speed * Math.sin(pose.th) * dtS;
  const th = pose.th + (direction * speed * Math.tan(steer) * dtS) / WHEELBASE_M;
  const advanced = Math.min(route.length_m, routeS + speed * dtS);
  const signedSpeed = direction * speed;
  return {
    pose: { x: round6(x), y: round6(y), th: round6(normalizeAngle(th)) },
    v: round6(signedSpeed),
    route_s: round6(advanced),
    gear,
    finished: advanced >= route.length_m - ROUTE_END_EPS_M,
  };
}

/** Hình chiếu một điểm lên lộ trình: quãng đường + lệch ngang. */
export function progressOnRoute(
  route: Route,
  point: Vec2,
): { readonly s: number; readonly lateral: number } {
  const projection = projectOnPolyline(routePositions(route), point);
  return { s: projection.distance_along, lateral: projection.lateral };
}

/**
 * Quãng đường tối đa còn được tiến để giữ khoảng hở ≥ `MIN_GAP_M` với xe trước
 * trên cùng lộ trình (REPORT_P5a #6). Trả `routeS` cũ nếu đã sát.
 */
export function maxRouteSForGap(
  routeS: number,
  leaderS: number | null,
  selfLength: number,
  leaderLength: number,
  minGap: number = MIN_GAP_M,
): number {
  if (leaderS === null) {
    return Number.POSITIVE_INFINITY;
  }
  const allowed = leaderS - (selfLength + leaderLength) / 2 - minGap;
  return Math.max(routeS, allowed);
}

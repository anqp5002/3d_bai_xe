/**
 * P5f — **nguồn ưu tiên duy nhất** cho D7 (bám xe), D8 (đặt chỗ vùng quét) và U8 (cổng một làn).
 *
 * Lý do tồn tại: trước P5f mỗi cơ chế tự quyết "ai nhường ai" —
 * `leaderGap` bỏ qua `leaving_slot`, `clipCheck` chặn cả hai phía, `canEnterGate` xếp hàng theo
 * hình học lộ trình, `reservations` cấp vùng theo thứ tự op. Bốn định nghĩa rời nhau sinh ra
 * **vòng chờ**: A dừng vì B, B dừng vì A (đo được ở K2/K4/K7 — xem `REPORT_P10a.md` mục 5).
 *
 * Nay tất cả gọi :func:`yieldsTo`. Quan hệ này là **thứ tự toàn phần** (id là khoá cuối, không
 * bao giờ trùng) nên **không thể** có vòng chờ: với mọi cặp, đúng một trong
 * `yieldsTo(a,b)` / `yieldsTo(b,a)` là `true`.
 *
 * Thứ tự ưu tiên (ANS_P10a, xe **đứng trước** thắng):
 * 1. Xe đang giữ đặt chỗ ở **vùng đang tranh** (D8) thắng xe chưa giữ.
 * 2. Xe đang **rời bãi** (`leaving_slot`, `driving_to_exit`) thắng xe đang vào.
 * 3. Xe **tới vùng tranh sớm hơn** thắng (frame xin đặt chỗ, hoặc frame xuất hiện nếu chưa giữ).
 * 4. Hoà thì **id nhỏ hơn** thắng.
 *
 * Hàm thuần dữ liệu: chỉ đọc `CarState`/`Reservation`, không đọc thời gian thực, không RNG.
 */

import type { Vec2 } from '../contracts/lot';
import type { CarState, Reservation } from '../contracts/sim';
import { polygonsIntersect } from './collision';

/** Ngữ cảnh cần cho quyết định ưu tiên. */
export interface PriorityWorld {
  /** Toàn bộ đặt chỗ đang hiệu lực. */
  readonly reservations: readonly Reservation[];
  /**
   * Vùng đang tranh (đa giác world). Có thì bước 1 chỉ xét đặt chỗ **giao vùng này**;
   * không có thì xét mọi đặt chỗ của xe.
   */
  readonly zone?: readonly Vec2[];
  /**
   * Tập vùng đang tranh (nhiều đa giác) — dùng khi cặp xe có thể tranh ở **nhiều** vùng cùng lúc.
   *
   * P5f: để `yieldsTo` **phản xứng** (đúng một chiều), hai lần gọi cho cùng một cặp phải xét
   * **cùng** tập vùng. Nếu mỗi chiều truyền vùng của xe kia, có cặp cả hai đều "đang giữ" ⇒ cả
   * hai cùng nhường ⇒ kẹt (đo được ở K7 f960: V002/V003 đều giữ vùng nên hai chiều đều `true`).
   * Ưu tiên `zones` hơn `zone` khi cả hai có mặt.
   */
  readonly zones?: readonly (readonly Vec2[])[];
}

/** Trạng thái đang **rời bãi** — được ưu tiên hơn xe đang vào (giải phóng chỗ, tránh vòng chờ). */
const LEAVING_STATES: ReadonlySet<string> = new Set(['leaving_slot', 'driving_to_exit']);

/**
 * Giá trị "chưa tới vùng tranh".
 *
 * Xe chưa giữ đặt chỗ thì bước 1 của khoá đã xếp nó **sau** xe đang giữ, nên giá trị này không
 * ảnh hưởng kết quả giữa hai xe khác nhau về bước 1. Nó chỉ cần **hữu hạn** để khoá vẫn so sánh
 * được và để phép so cuối cùng rơi xuống `id`.
 */
const NOT_YET_IN_ZONE = Number.MAX_SAFE_INTEGER;

function carNumber(carId: string): number {
  const match = /^V(\d+)$/.exec(carId);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

/** Đa giác "vùng tranh" thực sự cần xét: `zones` nếu có, ngược lại `[zone]`, ngược lại rỗng. */
function conflictZones(world: PriorityWorld): readonly (readonly Vec2[])[] {
  if (world.zones !== undefined) {
    return world.zones;
  }
  return world.zone === undefined ? [] : [world.zone];
}

/** Có giao với **bất kỳ** vùng tranh nào không (hoặc không có vùng tranh ⇒ mọi vùng đều tính). */
function overlapsConflict(polygon: readonly Vec2[], world: PriorityWorld): boolean {
  const zones = conflictZones(world);
  if (zones.length === 0) {
    return true;
  }
  return zones.some((zone) => polygonsIntersect([...polygon], zone));
}

/** Xe có đang giữ đặt chỗ ở vùng đang tranh không. */
function holdsZone(car: CarState, world: PriorityWorld): boolean {
  for (const reservation of world.reservations) {
    if (reservation.car_id !== car.id) {
      continue;
    }
    if (overlapsConflict(reservation.polygon, world)) {
      return true;
    }
  }
  return false;
}

/**
 * Frame mà xe "tới vùng tranh": frame xin đặt chỗ nếu đang giữ vùng đó, ngược lại
 * :data:`NOT_YET_IN_ZONE` (xe chưa giữ thì chưa thực sự tranh vùng — bước 1 đã phân xử).
 * Số nhỏ hơn = tới sớm hơn.
 */
function arrivalFrame(car: CarState, world: PriorityWorld): number {
  let earliest: number | null = null;
  for (const reservation of world.reservations) {
    if (reservation.car_id !== car.id) {
      continue;
    }
    if (!overlapsConflict(reservation.polygon, world)) {
      continue;
    }
    earliest = earliest === null ? reservation.since_frame : Math.min(earliest, reservation.since_frame);
  }
  return earliest ?? NOT_YET_IN_ZONE;
}

/**
 * Khoá so sánh: **nhỏ hơn = được đi trước**. Bộ ba (giữ vùng, rời bãi, tới sớm) rồi tới id.
 *
 * Trả mảng so sánh được theo từng phần tử; `id` là phần tử cuối nên khoá **không bao giờ trùng**.
 */
function priorityKey(car: CarState, world: PriorityWorld): readonly [number, number, number, number] {
  return [
    holdsZone(car, world) ? 0 : 1,
    LEAVING_STATES.has(car.state) ? 0 : 1,
    arrivalFrame(car, world),
    carNumber(car.id),
  ];
}

/**
 * `a` có **nhường** `b` không (tức `b` được đi trước).
 *
 * Với mọi cặp xe khác nhau, đúng một trong `yieldsTo(a,b)` và `yieldsTo(b,a)` là `true`
 * (khoá cuối là số hiệu xe, duy nhất trong một kịch bản).
 */
export function yieldsTo(a: CarState, b: CarState, world: PriorityWorld): boolean {
  if (a.id === b.id) {
    return false;
  }
  const ka = priorityKey(a, world);
  const kb = priorityKey(b, world);
  // Ba khoá đầu (giữ vùng, rời bãi, tới sớm) quyết định trước. Hoà ở cả ba thì xét hình học
  // (lead, sau ANS_11): xe ĐI TRƯỚC (nằm phía trước mũi xe kia) thắng — "ai ở đầu thì đi trước",
  // không phải "id nhỏ". Hai xe cùng rời bãi gặp nhau ở chỗ nhập làn (K6: V007 ở phía trước,
  // V002 phía sau nhưng id nhỏ hơn) mà xét theo id thì xe SAU thắng và cứ đâm vào đuôi xe TRƯỚC
  // đang quay đầu, cả hai khoá nhau ở mức chạm. Phản xứng theo cấu tạo: chỉ trả quyết định khi
  // đúng MỘT bên thấy bên kia ở phía trước.
  for (let index = 0; index < 3; index += 1) {
    if (ka[index] !== kb[index]) {
      return ka[index] > kb[index];
    }
  }
  const aSeesBAhead = isAhead(a, b);
  const bSeesAAhead = isAhead(b, a);
  if (aSeesBAhead !== bSeesAAhead) {
    // `a` thấy `b` ở phía trước mình (và `b` KHÔNG thấy `a` ở phía trước) ⇒ `b` đi trước ⇒ `a` nhường.
    return aSeesBAhead;
  }
  if (ka[3] !== kb[3]) {
    return ka[3] > kb[3];
  }
  // Không tới được: `carNumber` là khoá cuối và id duy nhất. Giữ nhánh này để hàm luôn trả
  // `boolean` kể cả khi id không theo dạng V### (khi đó so chuỗi để vẫn tất định).
  return a.id > b.id;
}

/** Mô tả ngắn để đưa vào cảnh báo/test. */
export function describePriority(a: CarState, b: CarState, world: PriorityWorld): string {
  const winner = yieldsTo(a, b, world) ? b : a;
  return `${winner.id} được đi trước`;
}

/** `other` nằm phía TRƯỚC mũi `car` (theo hướng xe `car`). */
function isAhead(car: CarState, other: CarState): boolean {
  const along =
    (other.pose.x - car.pose.x) * Math.cos(car.pose.th) +
    (other.pose.y - car.pose.y) * Math.sin(car.pose.th);
  return along > 0;
}

/** Khoảng cách Euclid giữa hai tâm xe, m. */
export function carDistance(a: CarState, b: CarState): number {
  return Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y);
}

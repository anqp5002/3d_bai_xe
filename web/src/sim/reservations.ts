/**
 * Đặt chỗ vùng quét khi vào/ra ô (C7, D8; FE §4.4.3).
 *
 * Quy ước hợp đồng:
 * 1. **Tất cả hoặc không**: vùng xin giữ là một đa giác nguyên khối (hợp các hình chữ
 *    nhật dọc thao tác). Không giữ được cả vùng thì không giữ phần nào.
 * 2. **Ưu tiên**: xe đang ra ô (`leave_out`) > xe đang vào (`park_in`) khi hai yêu cầu
 *    đến cùng frame — `resolveReservations` xếp thứ tự trước khi cấp.
 * 3. **Không kẹt vĩnh viễn**: hàm không bao giờ để xe vừa giữ vùng vừa chờ. Yêu cầu bị
 *    từ chối thì không giữ gì; caller thử lại frame sau và vùng sẽ trống khi xe kia
 *    nhả. Vì lối là vòng một chiều (D6) nên không tồn tại chu trình chờ khép kín.
 *
 * Hàm thuần dữ liệu, không biết hình lối — P5b truyền đa giác vùng quét đã tính.
 */

import type { SlotId, Vec2 } from '../contracts/lot';
import type { Reservation } from '../contracts/sim';
import { polygonsIntersect } from './collision';

/** Thao tác giữ vùng (contract C-A `Reservation.op`). */
export type ManeuverOp = 'park_in' | 'leave_out';

/** Yêu cầu giữ vùng của một xe. */
export interface ReservationRequest {
  readonly car_id: string;
  readonly slot: SlotId;
  readonly op: ManeuverOp;
  /** Vùng quét của thao tác, m (đa giác đơn, ≥ 3 đỉnh). */
  readonly polygon: readonly Vec2[];
  /** Frame bắt đầu xin giữ. */
  readonly frame: number;
}

/** Kết quả cấp vùng cho một yêu cầu. */
export type ReserveResult =
  | { readonly ok: true; readonly reservations: readonly Reservation[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly blockingCarId: string | null;
    };

/** Kết quả cấp vùng cho một lô yêu cầu cùng frame. */
export interface ReservationBatch {
  readonly granted: readonly Reservation[];
  readonly denied: readonly {
    readonly request: ReservationRequest;
    readonly reason: string;
    readonly blockingCarId: string | null;
  }[];
}

/** Số ưu tiên nhỏ hơn = được cấp trước (D8: ra ô trước, vào ô sau). */
export function reservationPriority(op: ManeuverOp): number {
  switch (op) {
    case 'leave_out':
      return 0;
    case 'park_in':
      return 1;
    default: {
      const exhaustive: never = op;
      throw new Error(`reservationPriority: thao tác lạ ${String(exhaustive)}`);
    }
  }
}

function assertPolygon(polygon: readonly Vec2[], owner: string): void {
  if (polygon.length < 3) {
    throw new Error(`${owner}: vùng giữ phải có ≥ 3 đỉnh, nhận ${polygon.length}`);
  }
}

/** Vùng của hai lần giữ có giao nhau không. */
export function regionsOverlap(
  a: readonly Vec2[],
  b: readonly Vec2[],
): boolean {
  return polygonsIntersect(a, b);
}

/**
 * Vùng `polygon` còn trống không (bỏ qua giữ của chính `ignoreCarId`).
 * Trả xe đang chặn để báo lý do cụ thể, không chỉ "bận".
 */
export function findBlockingReservation(
  existing: readonly Reservation[],
  polygon: readonly Vec2[],
  ignoreCarId?: string,
): Reservation | null {
  for (const reservation of existing) {
    if (reservation.car_id === ignoreCarId) {
      continue;
    }
    if (regionsOverlap(polygon, reservation.polygon)) {
      return reservation;
    }
  }
  return null;
}

function denialReason(
  request: ReservationRequest,
  blocking: Reservation,
): string {
  const opLabel = blocking.op === 'leave_out' ? 'đang ra ô' : 'đang vào ô';
  if (request.op === 'park_in' && blocking.op === 'leave_out') {
    return `vùng bị ${blocking.car_id} (${opLabel}) giữ — D8 ưu tiên xe đang ra`;
  }
  return `vùng bị ${blocking.car_id} (${opLabel}) giữ`;
}

/**
 * Xin giữ vùng cho một xe. Không bao giờ trả về trạng thái "giữ một phần".
 * Cùng xe xin lại đúng thao tác/ô đang giữ → coi như đã cấp (idempotent).
 */
export function reserve(
  existing: readonly Reservation[],
  request: ReservationRequest,
): ReserveResult {
  assertPolygon(request.polygon, `reserve(${request.car_id})`);
  if (!Number.isInteger(request.frame) || request.frame < 0) {
    throw new Error(
      `reserve(${request.car_id}): frame phải là số nguyên ≥ 0, nhận ${String(request.frame)}`,
    );
  }
  const own = existing.find((reservation) => reservation.car_id === request.car_id);
  if (own !== undefined) {
    if (own.slot === request.slot && own.op === request.op) {
      return { ok: true, reservations: existing };
    }
    return {
      ok: false,
      reason: `${request.car_id} đang giữ vùng của thao tác khác — phải nhả trước`,
      blockingCarId: request.car_id,
    };
  }
  const blocking = findBlockingReservation(existing, request.polygon);
  if (blocking !== null) {
    return {
      ok: false,
      reason: denialReason(request, blocking),
      blockingCarId: blocking.car_id,
    };
  }
  const granted: Reservation = {
    car_id: request.car_id,
    slot: request.slot,
    polygon: request.polygon,
    since_frame: request.frame,
    op: request.op,
  };
  return { ok: true, reservations: [...existing, granted] };
}

/**
 * Cấp vùng cho một lô yêu cầu trong cùng frame: xếp ưu tiên (ra ô trước), rồi frame,
 * rồi mã xe để tất định; cấp lần lượt theo kiểu tất cả hoặc không.
 */
export function resolveReservations(
  existing: readonly Reservation[],
  requests: readonly ReservationRequest[],
): ReservationBatch {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.car_id)) {
      throw new Error(
        `resolveReservations: xe ${request.car_id} có hai yêu cầu trong cùng lô`,
      );
    }
    seen.add(request.car_id);
  }
  const ordered = [...requests].sort((a, b) => {
    const byPriority = reservationPriority(a.op) - reservationPriority(b.op);
    if (byPriority !== 0) {
      return byPriority;
    }
    if (a.frame !== b.frame) {
      return a.frame - b.frame;
    }
    return a.car_id.localeCompare(b.car_id);
  });
  let reservations: readonly Reservation[] = existing;
  const granted: Reservation[] = [];
  const denied: ReservationBatch['denied'][number][] = [];
  for (const request of ordered) {
    const result = reserve(reservations, request);
    if (result.ok) {
      reservations = result.reservations;
      granted.push(
        reservations[reservations.length - 1],
      );
      continue;
    }
    denied.push({
      request,
      reason: result.reason,
      blockingCarId: result.blockingCarId,
    });
  }
  return { granted, denied };
}

/** Nhả vùng của một xe (thao tác xong hoặc xe bị hủy). */
export function release(
  existing: readonly Reservation[],
  carId: string,
): readonly Reservation[] {
  return existing.filter((reservation) => reservation.car_id !== carId);
}

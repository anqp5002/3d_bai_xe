import { describe, expect, it } from 'vitest';
import type { SlotId, Vec2 } from '../contracts/lot';
import type { Reservation } from '../contracts/sim';
import {
  findBlockingReservation,
  regionsOverlap,
  release,
  reservationPriority,
  reserve,
  resolveReservations,
  type ReservationRequest,
} from './reservations';

const SLOT: SlotId = 'S001';
const SLOT_B: SlotId = 'S002';

function square(x: number, y: number, size: number): readonly Vec2[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
}

function request(
  carId: string,
  polygon: readonly Vec2[],
  op: 'park_in' | 'leave_out' = 'park_in',
  frame = 0,
  slot: SlotId = SLOT,
): ReservationRequest {
  return { car_id: carId, slot, op, polygon, frame };
}

function reservation(
  carId: string,
  polygon: readonly Vec2[],
  op: 'park_in' | 'leave_out' = 'park_in',
  frame = 0,
): Reservation {
  return { car_id: carId, slot: SLOT, polygon, since_frame: frame, op };
}

describe('reservations — vùng quét và đặt chỗ tất cả hoặc không', () => {
  it('nhận diện giao vùng', () => {
    expect(regionsOverlap(square(0, 0, 4), square(2, 2, 4))).toBe(true);
    expect(regionsOverlap(square(0, 0, 4), square(10, 10, 4))).toBe(false);
  });

  it('cấp vùng trống và ghi since_frame', () => {
    const result = reserve([], request('V001', square(0, 0, 4), 'park_in', 12));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0].since_frame).toBe(12);
  });

  it('vùng bị chiếm → từ chối, không giữ một phần', () => {
    const existing = [reservation('V001', square(0, 0, 4))];
    const result = reserve(existing, request('V002', square(2, 2, 4)));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.blockingCarId).toBe('V001');
    expect(existing).toHaveLength(1);
  });

  it('cùng xe xin lại đúng thao tác → idempotent; thao tác khác → từ chối', () => {
    const existing = [reservation('V001', square(0, 0, 4), 'park_in', 3)];
    const again = reserve(existing, request('V001', square(0, 0, 4), 'park_in', 3));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.reservations).toHaveLength(1);
    }
    const other = reserve(existing, request('V001', square(20, 20, 4), 'leave_out', 4));
    expect(other.ok).toBe(false);
  });

  it('đa giác/khung hình sai → ném lỗi (R2)', () => {
    expect(() =>
      reserve([], request('V001', [[0, 0], [1, 1]])),
    ).toThrow();
    expect(() =>
      reserve([], request('V001', square(0, 0, 4), 'park_in', -1)),
    ).toThrow();
  });

  it('findBlockingReservation bỏ qua chính xe đang xét', () => {
    const existing = [reservation('V001', square(0, 0, 4))];
    expect(findBlockingReservation(existing, square(0, 0, 4))?.car_id).toBe('V001');
    expect(findBlockingReservation(existing, square(0, 0, 4), 'V001')).toBeNull();
  });
});

describe('reservations — ưu tiên D8 và không kẹt', () => {
  it('xe đang ra ô được cấp trước xe đang vào khi cùng frame', () => {
    const batch = resolveReservations([], [
      request('V002', square(0, 0, 10), 'park_in', 10, SLOT),
      request('V001', square(0, 0, 10), 'leave_out', 10, SLOT_B),
    ]);
    expect(batch.granted.map((item) => item.car_id)).toEqual(['V001']);
    expect(batch.denied).toHaveLength(1);
    expect(batch.denied[0].request.car_id).toBe('V002');
    expect(batch.denied[0].blockingCarId).toBe('V001');
  });

  it('hai vùng không giao thì cả hai được cấp', () => {
    const batch = resolveReservations([], [
      request('V001', square(0, 0, 4)),
      request('V002', square(10, 10, 4)),
    ]);
    expect(batch.granted).toHaveLength(2);
    expect(batch.denied).toHaveLength(0);
  });

  it('thứ tự tất định: cùng frame thì xếp theo mã xe', () => {
    const requests = [
      request('V003', square(0, 0, 5)),
      request('V001', square(0, 0, 5)),
      request('V002', square(0, 0, 5)),
    ];
    const first = resolveReservations([], requests);
    const second = resolveReservations([], requests);
    expect(first.granted.map((item) => item.car_id)).toEqual(['V001']);
    expect(second.denied.map((item) => item.request.car_id)).toEqual([
      'V002',
      'V003',
    ]);
  });

  it('một xe có hai yêu cầu trong cùng lô → lỗi lập trình', () => {
    expect(() =>
      resolveReservations([], [
        request('V001', square(0, 0, 4)),
        request('V001', square(10, 10, 4)),
      ]),
    ).toThrow();
  });

  it('vòng chờ nhỏ: không giữ vùng khi chờ, nhả là xe khác vào được', () => {
    const region = square(0, 0, 4);
    let state: readonly Reservation[] = [];
    const held = reserve(state, request('V001', region, 'leave_out', 0));
    expect(held.ok).toBe(true);
    if (!held.ok) {
      return;
    }
    state = held.reservations;

    // Hai xe xin cùng vùng đang bị giữ: cả hai bị từ chối, không ai giữ một phần.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const batch = resolveReservations(state, [
        request('V002', region, 'park_in', 1),
        request('V003', region, 'park_in', 1),
      ]);
      expect(batch.granted).toHaveLength(0);
      expect(state).toHaveLength(1);
    }

    state = release(state, 'V001');
    const afterRelease = resolveReservations(state, [
      request('V002', region, 'park_in', 5),
      request('V003', region, 'park_in', 5),
    ]);
    expect(afterRelease.granted.map((item) => item.car_id)).toEqual(['V002']);
    state = [...state, ...afterRelease.granted];
    expect(state).toHaveLength(1);

    state = release(state, 'V002');
    const last = resolveReservations(state, [request('V003', region, 'park_in', 9)]);
    expect(last.granted.map((item) => item.car_id)).toEqual(['V003']);
  });

  it('ưu tiên: leave_out (0) trước park_in (1)', () => {
    expect(reservationPriority('leave_out')).toBeLessThan(
      reservationPriority('park_in'),
    );
  });
});

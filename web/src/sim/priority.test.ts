/**
 * P5f — test cho **nguồn ưu tiên duy nhất** (`sim/priority.ts`).
 *
 * Trọng tâm: quan hệ phải là **thứ tự toàn phần** — với mọi cặp xe, đúng MỘT trong
 * `yieldsTo(a,b)` / `yieldsTo(b,a)` là `true`. Đó là điều kiện đủ để không thể có vòng chờ.
 */

import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../contracts/lot';
import type { CarState, CarStateName, Reservation } from '../contracts/sim';
import { yieldsTo } from './priority';
import type { PriorityWorld } from './priority';

function car(
  id: string,
  state: CarStateName,
  x = 0,
  y = 0,
): CarState {
  return {
    id,
    model: 'sedan',
    color: 'white',
    length: 4.6,
    width: 1.8,
    scale: 1,
    pose: { x, y, th: 0 },
    v: 0,
    state,
    slot: 'S001',
  };
}

function box(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function reservation(
  carId: string,
  polygon: readonly Vec2[],
  sinceFrame: number,
  op: 'park_in' | 'leave_out' = 'park_in',
): Reservation {
  return { car_id: carId, slot: 'S001', polygon, since_frame: sinceFrame, op };
}

function world(reservations: readonly Reservation[], zone?: readonly Vec2[]): PriorityWorld {
  return zone === undefined ? { reservations } : { reservations, zone };
}

describe('P5f priority — thứ tự toàn phần', () => {
  it('với mọi cặp: đúng MỘT trong yieldsTo(a,b)/yieldsTo(b,a) là true', () => {
    const states: CarStateName[] = [
      'queued',
      'entering',
      'driving_to_slot',
      'parking_in',
      'parked',
      'leaving_slot',
      'driving_to_exit',
    ];
    const cars: CarState[] = [];
    for (let index = 0; index < states.length; index += 1) {
      cars.push(car(`V${String(index + 1).padStart(3, '0')}`, states[index], index, 0));
    }
    const zone = box(0, 0, 10, 10);
    const scenarios: PriorityWorld[] = [
      world([]),
      world([], zone),
      world([reservation('V003', box(0, 0, 5, 5), 100)], zone),
      world(
        [
          reservation('V002', box(0, 0, 5, 5), 50, 'leave_out'),
          reservation('V005', box(0, 0, 5, 5), 50, 'park_in'),
        ],
        zone,
      ),
      world(
        [
          reservation('V004', box(0, 0, 5, 5), 10),
          reservation('V006', box(4, 4, 9, 9), 10),
        ],
        zone,
      ),
    ];

    for (const scenario of scenarios) {
      for (const a of cars) {
        for (const b of cars) {
          if (a.id === b.id) {
            expect(yieldsTo(a, b, scenario), `${a.id} nhường chính nó`).toBe(false);
            continue;
          }
          const ab = yieldsTo(a, b, scenario);
          const ba = yieldsTo(b, a, scenario);
          expect(
            ab !== ba,
            `${a.id}(${a.state}) vs ${b.id}(${b.state}): ab=${String(ab)} ba=${String(ba)} — phải đúng một chiều`,
          ).toBe(true);
        }
      }
    }
  });

  it('không có chu trình: sắp theo yieldsTo là thứ tự nghiêm ngặt', () => {
    const cars = [
      car('V001', 'driving_to_slot'),
      car('V002', 'driving_to_exit'),
      car('V003', 'leaving_slot'),
      car('V004', 'entering'),
      car('V005', 'queued'),
    ];
    const w = world([]);
    // Sắp xếp bằng yieldsTo: nếu quan hệ có chu trình thì sort sẽ không ổn định/tự mâu thuẫn.
    const sorted = [...cars].sort((a, b) => (yieldsTo(a, b, w) ? 1 : yieldsTo(b, a, w) ? -1 : 0));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        // Phần tử đứng sau phải nhường phần tử đứng trước.
        expect(
          yieldsTo(sorted[j], sorted[i], w),
          `${sorted[j].id} phải nhường ${sorted[i].id}`,
        ).toBe(true);
      }
    }
  });
});

describe('P5f priority — luật ưu tiên (ANS_P10a)', () => {
  it('(1) xe đang giữ đặt chỗ vùng tranh thắng xe chưa giữ', () => {
    const zone = box(0, 0, 10, 10);
    const holder = car('V009', 'driving_to_slot');
    const other = car('V001', 'driving_to_slot');
    const w = world([reservation('V009', box(0, 0, 5, 5), 100)], zone);

    expect(yieldsTo(other, holder, w), 'V001 phải nhường V009 dù id lớn hơn').toBe(true);
    expect(yieldsTo(holder, other, w)).toBe(false);
  });

  it('(1) đặt chỗ KHÔNG giao vùng tranh thì không được ưu tiên', () => {
    const zone = box(0, 0, 10, 10);
    const far = car('V009', 'driving_to_slot');
    const other = car('V001', 'driving_to_slot');
    // Vùng đặt chỗ nằm ngoài vùng đang tranh.
    const w = world([reservation('V009', box(50, 50, 60, 60), 100)], zone);

    expect(yieldsTo(far, other, w), 'đặt chỗ ngoài vùng tranh không giúp gì').toBe(true);
  });

  it('(2) xe đang rời bãi thắng xe đang vào', () => {
    const w = world([]);
    const leaving = car('V009', 'leaving_slot');
    const entering = car('V001', 'driving_to_slot');
    const exiting = car('V009', 'driving_to_exit');

    expect(yieldsTo(entering, leaving, w), 'xe vào nhường xe ra').toBe(true);
    expect(yieldsTo(leaving, entering, w)).toBe(false);
    expect(yieldsTo(entering, exiting, w), 'xe vào nhường xe ra cổng').toBe(true);
    expect(yieldsTo(exiting, entering, w)).toBe(false);
  });

  it('(1) mạnh hơn (2): giữ vùng thắng cả xe đang rời bãi', () => {
    const zone = box(0, 0, 10, 10);
    const holder = car('V009', 'driving_to_slot');
    const leaving = car('V001', 'leaving_slot');
    const w = world([reservation('V009', box(0, 0, 5, 5), 100)], zone);

    expect(yieldsTo(leaving, holder, w)).toBe(true);
    expect(yieldsTo(holder, leaving, w)).toBe(false);
  });

  it('(3) tới vùng tranh sớm hơn thắng khi cùng hạng', () => {
    const zone = box(0, 0, 10, 10);
    const early = car('V009', 'parking_in');
    const late = car('V001', 'parking_in');
    const w = world(
      [
        reservation('V009', box(0, 0, 5, 5), 10),
        reservation('V001', box(0, 0, 5, 5), 90),
      ],
      zone,
    );

    expect(yieldsTo(late, early, w), 'V001 xin sau nên nhường V009 dù id nhỏ hơn').toBe(true);
    expect(yieldsTo(early, late, w)).toBe(false);
  });

  it('(4) hoà hết thì id nhỏ hơn thắng', () => {
    const w = world([]);
    const small = car('V002', 'driving_to_slot');
    const big = car('V010', 'driving_to_slot');

    expect(yieldsTo(big, small, w)).toBe(true);
    expect(yieldsTo(small, big, w)).toBe(false);
  });

  it('so số hiệu theo số, không theo chuỗi (V010 > V009)', () => {
    const w = world([]);
    const nine = car('V009', 'driving_to_slot');
    const ten = car('V010', 'driving_to_slot');

    expect(yieldsTo(ten, nine, w), 'V010 phải nhường V009 (số 10 > 9)').toBe(true);
  });
});

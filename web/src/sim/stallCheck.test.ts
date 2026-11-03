import { describe, expect, it } from 'vitest';
import type { CarState, SimState } from '../contracts/sim';
import { describeStalls, findStalls, findStillAtEnd, STALL_FRAMES_LIMIT } from './stallCheck';
import {
  describeQueue,
  findAbandonedQueue,
  QUEUE_WAIT_FRAMES_LIMIT,
  queueAtEnd,
} from './stallCheck';

/** Tổng hợp history giả để chắc bộ kiểm bắt được kẹt. */
function fakeCar(id: string, v: number, state: CarState['state'], x = 0): CarState {
  return {
    id,
    model: 'sedan',
    color: 'white',
    length: 4.6,
    width: 1.8,
    scale: 1,
    pose: { x, y: 0, th: 0 },
    v,
    state,
    slot: 'S001',
  };
}

function fakeState(frame: number, cars: readonly CarState[]): SimState {
  return {
    frame,
    cars,
    reservations: [],
    rngState: {} as SimState['rngState'],
    warnings: [],
  };
}

describe('stallCheck — bộ kiểm không cho xanh giả', () => {
  it('bắt xe đứng yên > 250 frame giữa chừng', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= STALL_FRAMES_LIMIT + 10; f += 1) {
      history.push(fakeState(f, [fakeCar('V001', 0, 'driving_to_slot')]));
    }
    const stalls = findStalls(history);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].car_id).toBe('V001');
    expect(stalls[0].frames).toBeGreaterThan(STALL_FRAMES_LIMIT);
    expect(describeStalls(stalls)).toContain('V001');
  });

  it('KHÔNG bắt xe đỗ / xếp hàng / đã ra (đứng yên hợp lệ)', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= STALL_FRAMES_LIMIT + 50; f += 1) {
      history.push(
        fakeState(f, [
          fakeCar('V001', 0, 'parked'),
          fakeCar('V002', 0, 'queued'),
          fakeCar('V003', 0, 'exited'),
        ]),
      );
    }
    expect(findStalls(history)).toEqual([]);
    expect(findStillAtEnd(history)).toEqual([]);
  });

  it('KHÔNG bắt xe chạy chậm nhưng vẫn chạy (v ≠ 0)', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= STALL_FRAMES_LIMIT + 50; f += 1) {
      history.push(fakeState(f, [fakeCar('V001', 0.05, 'driving_to_slot')]));
    }
    expect(findStalls(history)).toEqual([]);
  });

  it('đứt quãng thì reset: 200 frame dừng + chạy + 200 frame dừng KHÔNG phải kẹt', () => {
    const history: SimState[] = [];
    let frame = 0;
    for (let i = 0; i < 200; i += 1) history.push(fakeState(frame++, [fakeCar('V001', 0, 'driving_to_slot')]));
    history.push(fakeState(frame++, [fakeCar('V001', 1, 'driving_to_slot')]));
    for (let i = 0; i < 200; i += 1) history.push(fakeState(frame++, [fakeCar('V001', 0, 'driving_to_slot')]));
    expect(findStalls(history)).toEqual([]);
  });

  it('findStillAtEnd bắt xe còn trong bãi và đứng yên ở cuối', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= STALL_FRAMES_LIMIT + 60; f += 1) {
      history.push(fakeState(f, [fakeCar('V001', 0, 'leaving_slot')]));
    }
    const still = findStillAtEnd(history);
    expect(still).toHaveLength(1);
    expect(still[0].state).toBe('leaving_slot');
  });

  it('findStillAtEnd KHÔNG bắt xe đã exited ở cuối', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= STALL_FRAMES_LIMIT + 60; f += 1) {
      history.push(fakeState(f, [fakeCar('V001', 0, 'exited')]));
    }
    expect(findStillAtEnd(history)).toEqual([]);
  });
});

describe('queueCheck — xe queued bị bỏ quên (lỗ hổng P10a)', () => {
  it('findStalls BỎ QUA queued (nên phải có bộ kiểm riêng)', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= 3000; f += 1) {
      history.push(fakeState(f, [fakeCar('V002', 0, 'queued')]));
    }
    // Đây chính là lỗ hổng: kẹt 3000 frame mà bộ kiểm cũ vẫn xanh.
    expect(findStalls(history)).toEqual([]);
    expect(findStillAtEnd(history)).toEqual([]);
    // Bộ kiểm mới phải bắt được.
    const abandoned = findAbandonedQueue(history);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].car_id).toBe('V002');
    expect(abandoned[0].frames).toBeGreaterThan(QUEUE_WAIT_FRAMES_LIMIT);
    expect(describeQueue(abandoned)).toContain('V002');
    expect(queueAtEnd(history)).toEqual(['V002']);
  });

  it('hàng chờ HỢP LỆ khi có xe đang qua cổng vào', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= 3000; f += 1) {
      history.push(
        fakeState(f, [
          fakeCar('V001', 2.7, 'entering'),
          fakeCar('V002', 0, 'queued'),
          fakeCar('V003', 0, 'queued'),
        ]),
      );
    }
    expect(findAbandonedQueue(history)).toEqual([]);
  });

  it('hàng chờ hợp lệ khi xe dẫn đường còn driving_to_slot', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= 3000; f += 1) {
      history.push(
        fakeState(f, [
          fakeCar('V001', 2.7, 'driving_to_slot'),
          fakeCar('V002', 0, 'queued'),
        ]),
      );
    }
    expect(findAbandonedQueue(history)).toEqual([]);
  });

  it('ngắt quãng thì reset: có xe qua cổng xen giữa là hợp lệ', () => {
    const history: SimState[] = [];
    let frame = 0;
    for (let i = 0; i < 400; i += 1) {
      history.push(fakeState(frame++, [fakeCar('V002', 0, 'queued')]));
    }
    for (let i = 0; i < 50; i += 1) {
      history.push(
        fakeState(frame++, [
          fakeCar('V001', 2.7, 'driving_to_slot'),
          fakeCar('V002', 0, 'queued'),
        ]),
      );
    }
    for (let i = 0; i < 400; i += 1) {
      history.push(fakeState(frame++, [fakeCar('V002', 0, 'queued')]));
    }
    expect(findAbandonedQueue(history)).toEqual([]);
  });

  it('queueAtEnd rỗng khi mọi xe đã vào bãi', () => {
    const history: SimState[] = [];
    for (let f = 0; f <= 3000; f += 1) {
      history.push(
        fakeState(f, [
          fakeCar('V001', 0, 'parked'),
          fakeCar('V002', 0, 'exited'),
        ]),
      );
    }
    expect(queueAtEnd(history)).toEqual([]);
  });
});

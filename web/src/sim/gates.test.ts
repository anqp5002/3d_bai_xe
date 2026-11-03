import { describe, expect, it } from 'vitest';
import { DT_S } from '../contracts/sim';
import {
  canEnterGate,
  gateOccupant,
  gateQueue,
  isGateClear,
  isInsideGate,
  type GateCar,
} from './gates';

const LENGTH = 4.6;

function car(id: string, distance: number, length = LENGTH): GateCar {
  return { id, distance_m: distance, length_m: length };
}

describe('gates — chiếm đoạn cổng và khoảng cách an toàn', () => {
  it('mũi đúng vạch là đang chiếm; qua hết 1 chiều dài mới trống', () => {
    expect(isInsideGate(car('A', 0.01))).toBe(false);
    expect(isInsideGate(car('A', 0))).toBe(true);
    expect(isInsideGate(car('A', -LENGTH))).toBe(false);
    expect(isInsideGate(car('A', -LENGTH + 0.01))).toBe(true);
    expect(isGateClear(car('A', -LENGTH))).toBe(true);
    expect(isGateClear(car('A', -LENGTH + 0.01))).toBe(false);
  });

  it('gateOccupant trả xe đang chiếm, null khi trống', () => {
    expect(gateOccupant([car('A', 5), car('B', 9)])).toBeNull();
    const occupant = gateOccupant([car('A', 5), car('B', -1)]);
    expect(occupant?.id).toBe('B');
    expect(gateOccupant([car('A', -1), car('B', -2)])?.id).toBe('A');
  });

  it('hàng chờ xếp theo khoảng cách tăng dần, kèm cảnh báo lỗi kích thước', () => {
    const queue = gateQueue([car('C', 9), car('A', 3), car('B', -10)]);
    expect(queue.map((item) => item.id)).toEqual(['A', 'C']);
    expect(() => gateQueue([car('X', 1, 0)])).toThrow();
  });
});

describe('gates — một làn, xe kế chờ xe trước qua hết', () => {
  it('không cho vào khi còn xe trong đoạn cổng', () => {
    const decision = canEnterGate([car('A', 3), car('B', -1)], 'A');
    expect(decision.ok).toBe(false);
    expect(decision.occupantId).toBe('B');
    expect(isGateClear(car('B', -LENGTH))).toBe(true);
  });

  it('không cho vượt: chỉ xe gần cổng nhất được vào', () => {
    const decision = canEnterGate([car('A', 8), car('B', 3)], 'A');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('B');
    expect(canEnterGate([car('A', 8), car('B', 3)], 'B').ok).toBe(true);
  });

  it('xe đang trong cổng hoặc đã qua thì không phải lượt vào', () => {
    expect(canEnterGate([car('A', -1)], 'A').ok).toBe(false);
    expect(canEnterGate([car('A', -LENGTH)], 'A').ok).toBe(false);
  });

  it('xe không có trong danh sách → lỗi lập trình (R2)', () => {
    expect(() => canEnterGate([car('A', 3)], 'Z')).toThrow();
  });
});

describe('gates — mô phỏng 3 xe nối đuôi qua cổng', () => {
  it('mỗi frame tối đa 1 xe trong đoạn cổng, xe sau chỉ vào khi xe trước qua hết', () => {
    const speed = 2; // m/s
    const distances = new Map<string, number>([
      ['A', 5],
      ['B', 12],
      ['C', 19],
    ]);
    const snapshot = (): GateCar[] =>
      [...distances.entries()].map(([id, distance]) => car(id, distance));

    let crossings = 0;
    let maxOccupants = 0;
    for (let step = 0; step < 2000; step += 1) {
      maxOccupants = Math.max(
        maxOccupants,
        snapshot().filter((item) => isInsideGate(item)).length,
      );

      const before = new Map(distances);
      const orderedIds = [...distances.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id);
      for (const id of orderedIds) {
        const current = distances.get(id) ?? 0;
        const me = car(id, current);
        const mayMove = isInsideGate(me) || canEnterGate(snapshot(), id).ok;
        if (mayMove) {
          distances.set(id, current - speed * DT_S);
        }
      }

      for (const [id, distance] of distances) {
        const previous = before.get(id) ?? distance;
        if (previous <= 0 || distance > 0) {
          continue;
        }
        crossings += 1;
        for (const [otherId, otherDistance] of before) {
          if (otherId === id || otherDistance > 0) {
            continue;
          }
          expect(isGateClear(car(otherId, otherDistance))).toBe(true);
        }
      }
    }

    expect(maxOccupants).toBeLessThanOrEqual(1);
    expect(crossings).toBe(3);
  });
});

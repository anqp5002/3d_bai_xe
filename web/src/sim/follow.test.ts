import { describe, expect, it } from 'vitest';
import { DT_S } from '../contracts/sim';
import {
  FOLLOW_LENGTH_FACTOR,
  MAX_DECEL_MPS2,
  MIN_GAP_M,
  followSpeed,
  safeSpeedForGap,
} from './follow';

const CAR_LENGTH_M = 4.6;

describe('follow — phanh nhìn xa D7', () => {
  it('vận tốc an toàn = sqrt(2·a·(gap − gap_min))', () => {
    expect(safeSpeedForGap(MIN_GAP_M)).toBe(0);
    expect(safeSpeedForGap(2.0)).toBeCloseTo(
      Math.sqrt(2 * MAX_DECEL_MPS2 * (2.0 - MIN_GAP_M)),
      10,
    );
    expect(safeSpeedForGap(Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('gap ≤ gap_min → dừng hẳn', () => {
    const decision = followSpeed({
      desiredSpeed: 5,
      leaderSpeed: 5,
      gap: MIN_GAP_M,
      carLength: CAR_LENGTH_M,
    });
    expect(decision.targetSpeed).toBe(0);
    expect(decision.limit).toBe('stop');
  });

  it('gap < ½ chiều dài thì không nhanh hơn xe trước', () => {
    const decision = followSpeed({
      desiredSpeed: 0.5,
      leaderSpeed: 0.2,
      gap: 2.0,
      carLength: CAR_LENGTH_M,
    });
    expect(2.0).toBeLessThan(FOLLOW_LENGTH_FACTOR * CAR_LENGTH_M);
    expect(decision.targetSpeed).toBeLessThanOrEqual(0.2);
    expect(decision.limit).toBe('length');
  });

  it('gap ≥ ½ chiều dài thì luật ½L không kích hoạt, chỉ còn phanh nhìn xa', () => {
    const decision = followSpeed({
      desiredSpeed: 5,
      leaderSpeed: 0,
      gap: 10,
      carLength: CAR_LENGTH_M,
    });
    expect(decision.targetSpeed).toBe(5);
    expect(decision.limit).toBe('none');
  });

  it('phanh nhìn xa siết hơn luật ½L khi còn gần', () => {
    const decision = followSpeed({
      desiredSpeed: 5,
      leaderSpeed: 1,
      gap: 1.0,
      carLength: CAR_LENGTH_M,
    });
    expect(decision.limit).toBe('brake');
    expect(decision.targetSpeed).toBeLessThan(1);
  });

  it('gap NaN / chiều dài sai → ném lỗi (R2)', () => {
    expect(() =>
      followSpeed({ desiredSpeed: 1, leaderSpeed: 0, gap: Number.NaN, carLength: 4 }),
    ).toThrow();
    expect(() =>
      followSpeed({ desiredSpeed: 1, leaderSpeed: 0, gap: 5, carLength: 0 }),
    ).toThrow();
  });
});

/**
 * Mô phỏng tối giản: xe sau chạy tới xe trước đang đứng yên.
 * Tích phân Euler với dt = 0,04 s và phản ứng tức thời (không trễ) để đo khoảng hở.
 */
function simulateApproach(speedKmh: number): {
  readonly minGap: number;
  readonly finalGap: number;
  readonly stoppedAtStep: number;
} {
  const leaderRear = 15;
  const desired = speedKmh / 3.6;
  let front = 0;
  let speed = desired;
  let minGap = leaderRear - front;
  let stoppedAtStep = -1;
  for (let step = 0; step < 10_000; step += 1) {
    const gap = leaderRear - front;
    minGap = Math.min(minGap, gap);
    const decision = followSpeed({
      desiredSpeed: desired,
      leaderSpeed: 0,
      gap,
      carLength: CAR_LENGTH_M,
    });
    speed = Math.min(speed, decision.targetSpeed);
    if (speed < 1e-9) {
      stoppedAtStep = step;
      break;
    }
    front += speed * DT_S;
  }
  return { minGap, finalGap: leaderRear - front, stoppedAtStep };
}

describe('follow — xe trước dừng thì xe sau dừng, không chồng (U7 + D7)', () => {
  // Sai số ~1 mm do rời rạc hoá dt = 0,04 s; ngưỡng dưới 0,8 m không bị vi phạm đáng kể.
  const DISCRETE_TOLERANCE_M = 0.002;

  for (const speedKmh of [10, 20]) {
    it(`tốc độ ${speedKmh} km/h: dừng lại, gap ≥ 0,8 m`, () => {
      const result = simulateApproach(speedKmh);
      expect(result.stoppedAtStep).toBeGreaterThan(0);
      expect(result.finalGap).toBeGreaterThanOrEqual(MIN_GAP_M - DISCRETE_TOLERANCE_M);
      expect(result.minGap).toBeGreaterThanOrEqual(MIN_GAP_M - DISCRETE_TOLERANCE_M);
    });
  }
});

import { describe, expect, it } from 'vitest';
import type { CarState } from '../contracts/sim';
import {
  EMPTY_STUCK_TRACKER,
  STUCK_FRAMES,
  stillSeconds,
  updateStuck,
  type StuckTracker,
} from './stuck';

function car(id: string, v: number, state: CarState['state'] = 'driving_to_slot'): CarState {
  return {
    id,
    model: 'sedan',
    color: 'white',
    length: 4.6,
    width: 1.8,
    scale: 1.1,
    pose: { x: 0, y: 0, th: 0 },
    v,
    state,
    slot: 'S001',
  };
}

describe('stuck — xe đứng yên > 10 s (FE §4.4.5)', () => {
  it('chưa đủ 10 s thì chưa cảnh báo', () => {
    let tracker: StuckTracker = EMPTY_STUCK_TRACKER;
    let warned = 0;
    for (let frame = 0; frame <= STUCK_FRAMES; frame += 1) {
      const result = updateStuck(tracker, [car('V001', 0)], frame);
      tracker = result.tracker;
      warned += result.warnings.length;
    }
    expect(warned).toBe(0);
  });

  it('quá 10 s → cảnh báo đúng một lần cho mỗi đợt đứng yên', () => {
    let tracker: StuckTracker = EMPTY_STUCK_TRACKER;
    const warnings = [];
    for (let frame = 0; frame <= STUCK_FRAMES + 40; frame += 1) {
      const result = updateStuck(tracker, [car('V001', 0.01)], frame);
      tracker = result.tracker;
      warnings.push(...result.warnings);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('stuck');
    expect(warnings[0].frame).toBe(STUCK_FRAMES + 1);
    expect(warnings[0].car_id).toBe('V001');
    expect(warnings[0].slot).toBe('S001');
    expect(warnings[0].message).toContain('10.0 s');
  });

  it('parked/queued/exited không bao giờ bị cảnh báo kẹt', () => {
    let tracker: StuckTracker = EMPTY_STUCK_TRACKER;
    let warned = 0;
    for (let frame = 0; frame <= STUCK_FRAMES * 2; frame += 1) {
      const result = updateStuck(
        tracker,
        [car('V001', 0, 'parked'), car('V002', 0, 'queued'), car('V003', 0, 'exited')],
        frame,
      );
      tracker = result.tracker;
      warned += result.warnings.length;
    }
    expect(warned).toBe(0);
    expect(tracker.entries).toEqual({});
  });

  it('xe chạy lại thì bộ đếm được xoá, đứng lại phải đủ 10 s mới báo', () => {
    let tracker: StuckTracker = EMPTY_STUCK_TRACKER;
    for (let frame = 0; frame <= STUCK_FRAMES + 1; frame += 1) {
      tracker = updateStuck(tracker, [car('V001', 0)], frame).tracker;
    }
    expect(tracker.entries.V001.warned).toBe(true);

    tracker = updateStuck(tracker, [car('V001', 2)], STUCK_FRAMES + 2).tracker;
    expect(tracker.entries.V001).toBeUndefined();

    let warned = 0;
    for (let frame = STUCK_FRAMES + 3; frame <= STUCK_FRAMES * 2 + 2; frame += 1) {
      const result = updateStuck(tracker, [car('V001', 0)], frame);
      tracker = result.tracker;
      warned += result.warnings.length;
    }
    expect(warned).toBe(0);
  });

  it('xe biến mất khỏi danh sách → bộ đếm xoá', () => {
    let tracker = updateStuck(EMPTY_STUCK_TRACKER, [car('V001', 0)], 0).tracker;
    expect(tracker.entries.V001).toBeDefined();
    tracker = updateStuck(tracker, [], 1).tracker;
    expect(tracker.entries.V001).toBeUndefined();
  });

  it('stillSeconds quy frame ra giây', () => {
    expect(stillSeconds({ sinceFrame: 0, warned: false }, 0)).toBe(0);
    expect(stillSeconds({ sinceFrame: 10, warned: false }, 35)).toBeCloseTo(1, 10);
  });

  it('frame sai → ném lỗi (R2)', () => {
    expect(() => updateStuck(EMPTY_STUCK_TRACKER, [], -1)).toThrow();
  });
});

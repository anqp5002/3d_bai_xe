import { describe, expect, it } from 'vitest';
import { assertAppendableEvent, canAppendEvent, drawsRandom, type SimEvent } from './events';

const leaveEvent = (frame: number): SimEvent => ({
  frame,
  type: 'leave',
  params: { car_id: 'V001' },
});

describe('contracts/events', () => {
  it('nhật ký rỗng thì luôn thêm được', () => {
    expect(canAppendEvent([], 0)).toBe(true);
  });

  it('chỉ thêm được khi frame hiện tại ≥ frame sự kiện cuối (D9)', () => {
    const log = [leaveEvent(10)];
    expect(canAppendEvent(log, 10)).toBe(true);
    expect(canAppendEvent(log, 9)).toBe(false);
  });

  it('assertAppendableEvent ném lỗi khi chen vào giữa', () => {
    const log = [leaveEvent(10)];
    expect(() => assertAppendableEvent(log, leaveEvent(4))).toThrow(/D9 cấm tua lùi/);
    expect(() => assertAppendableEvent([], leaveEvent(-1))).toThrow(/frame âm/);
  });

  it('biết sự kiện nào cần ghi kết quả đã bốc', () => {
    const random = (['add_car', 'add_cars', 'leave_random'] as const).map(
      (type) =>
        ({
          frame: 0,
          type,
          params: {},
        }) as unknown as SimEvent,
    );
    for (const event of random) {
      expect(drawsRandom(event)).toBe(true);
    }
    expect(drawsRandom(leaveEvent(0))).toBe(false);
  });
});

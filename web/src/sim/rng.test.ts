import { describe, expect, it } from 'vitest';
import {
  RNG_STREAMS,
  chance,
  createRngStreams,
  drawFloat,
  drawInt,
  mulberry32,
  nextMulberry32,
  pickItem,
  shuffleItems,
} from './rng';

describe('rng — mulberry32 tất định (C3, G4)', () => {
  it('cùng seed cho cùng dãy, số trong [0, 1)', () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    const seriesA = Array.from({ length: 8 }, () => first());
    const seriesB = Array.from({ length: 8 }, () => second());
    expect(seriesA).toEqual(seriesB);
    for (const value of seriesA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('seed khác cho dãy khác', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('nextMulberry32 nối trạng thái khớp closure mulberry32', () => {
    const closure = mulberry32(1234);
    let state = 1234 >>> 0;
    for (let index = 0; index < 5; index += 1) {
      const draw = nextMulberry32(state);
      state = draw.state;
      expect(draw.value).toBe(closure());
      expect(state).toBe(state >>> 0);
    }
  });
});

describe('rng — trạng thái 6 luồng của SimState.rngState', () => {
  it('đủ 6 luồng, mỗi luồng là uint32', () => {
    const streams = createRngStreams(8811);
    expect(Object.keys(streams).sort()).toEqual([...RNG_STREAMS].sort());
    for (const name of RNG_STREAMS) {
      expect(Number.isInteger(streams[name])).toBe(true);
      expect(streams[name]).toBeGreaterThanOrEqual(0);
      expect(streams[name]).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('cùng seed → cùng trạng thái; seed sai → ném lỗi (R2)', () => {
    expect(createRngStreams(7)).toEqual(createRngStreams(7));
    expect(() => createRngStreams(-1)).toThrow();
    expect(() => createRngStreams(1.5)).toThrow();
  });

  it('rút một luồng không làm xê dịch luồng khác', () => {
    const fresh = createRngStreams(99);
    let placement = fresh;
    for (let index = 0; index < 20; index += 1) {
      placement = drawFloat(placement, 'placement').streams;
    }
    expect(placement.color).toBe(fresh.color);
    expect(placement.model).toBe(fresh.model);
    const afterDrawingPlacement = drawFloat(placement, 'color');
    const untouched = drawFloat(fresh, 'color');
    expect(afterDrawingPlacement.value).toBe(untouched.value);
    expect(afterDrawingPlacement.streams.color).toBe(untouched.streams.color);
  });

  it('drawInt nằm trong [0, maxExclusive) và maxExclusive sai → ném lỗi', () => {
    let streams = createRngStreams(5);
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      const draw = drawInt(streams, 'slot', 7);
      streams = draw.streams;
      expect(draw.value).toBeGreaterThanOrEqual(0);
      expect(draw.value).toBeLessThan(7);
      seen.add(draw.value);
    }
    expect(seen.size).toBe(7);
    expect(() => drawInt(streams, 'slot', 0)).toThrow();
    expect(() => drawInt(streams, 'slot', 1.5)).toThrow();
  });

  it('pickItem tất định và danh sách rỗng → ném lỗi', () => {
    const items = ['a', 'b', 'c'] as const;
    const first = pickItem(createRngStreams(3), 'model', items);
    const again = pickItem(createRngStreams(3), 'model', items);
    expect(first).toEqual(again);
    expect(items).toContain(first.value);
    expect(() => pickItem(createRngStreams(3), 'model', [])).toThrow();
  });

  it('shuffleItems là hoán vị, tất định, không sửa mảng gốc', () => {
    const source = [1, 2, 3, 4, 5, 6];
    const first = shuffleItems(createRngStreams(11), 'placement', source);
    const again = shuffleItems(createRngStreams(11), 'placement', source);
    expect(first.values).toEqual(again.values);
    expect([...first.values].sort((a, b) => a - b)).toEqual(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('chance biên 0/1 và giá trị sai → ném lỗi', () => {
    const streams = createRngStreams(17);
    expect(chance(streams, 'noise', 0).value).toBe(false);
    expect(chance(streams, 'noise', 1).value).toBe(true);
    expect(() => chance(streams, 'noise', 1.2)).toThrow();
  });
});

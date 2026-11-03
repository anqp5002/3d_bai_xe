import { describe, expect, it } from 'vitest';
import {
  SLOT_COUNT,
  SLOT_IDS,
  assertSlotId,
  findSlot,
  isSlotId,
  type LotMap,
} from './lot';

describe('contracts/lot', () => {
  it('có đúng 100 mã ô S001…S100, không trùng', () => {
    expect(SLOT_IDS).toHaveLength(100);
    expect(SLOT_COUNT).toBe(100);
    expect(new Set(SLOT_IDS).size).toBe(100);
    expect(SLOT_IDS[0]).toBe('S001');
    expect(SLOT_IDS[99]).toBe('S100');
  });

  it('isSlotId chỉ nhận mã đúng dạng', () => {
    expect(isSlotId('S001')).toBe(true);
    expect(isSlotId('S100')).toBe(true);
    expect(isSlotId('S000')).toBe(false);
    expect(isSlotId('S101')).toBe(false);
    expect(isSlotId('s001')).toBe(false);
    expect(isSlotId('F01')).toBe(false);
  });

  it('assertSlotId ném lỗi với mã sai thay vì im lặng (R2)', () => {
    expect(() => assertSlotId('F01')).toThrow(/không hợp lệ/);
  });

  it('findSlot ném lỗi khi bãi thiếu ô', () => {
    const emptyLot: LotMap = {
      name: 'pucpr',
      camera: {
        pitch_deg: 80,
        f_px: 288,
        height_m: 33.6,
        res: [640, 640],
        cam1_x: [0, 400],
        cam2_x: [240, 640],
      },
      slots: [],
      aisles: [],
      gates: {
        in: {
          p1: [0, 0],
          p2: [0, 1],
          p1_px: [615, 322],
          p2_px: [615, 364],
          spawn: [5, 0, 0],
          despawn: [6, 0],
        },
        out: {
          p1: [0, 0],
          p2: [0, 1],
          p1_px: [25, 322],
          p2_px: [25, 364],
          spawn: [-5, 0, 0],
          despawn: [-6, 0],
        },
      },
      decor: { grass: [], curbs: [], asphalt: [], trees: [], lamps: [] },
    };
    expect(() => findSlot(emptyLot, 'S001')).toThrow(/Không có ô "S001"/);
  });
});

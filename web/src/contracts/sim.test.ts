import { describe, expect, it } from 'vitest';
import {
  CAR_COLORS,
  CAR_COLOR_HEX,
  CAR_DIMENSIONS_M,
  CAR_MODELS,
  CAR_SCALE_DEFAULT,
  CAR_SCALE_MAX,
  CAR_SCALE_MIN,
  CAR_STATES,
  NARROW_SLOT_WIDTH_M,
  SLOT_EDGE_MARGIN_M,
  isHalted,
  type SimState,
} from './sim';

describe('contracts/sim — hằng số quyết định C4, C5, D4, D8', () => {
  it('3 mẫu xe đúng kích thước C4 (mét)', () => {
    expect(CAR_MODELS).toEqual(['sedan', 'suv', 'hatch']);
    expect(CAR_DIMENSIONS_M.sedan).toEqual([4.6, 1.8, 1.45]);
    expect(CAR_DIMENSIONS_M.suv).toEqual([4.7, 1.9, 1.7]);
    expect(CAR_DIMENSIONS_M.hatch).toEqual([4.0, 1.75, 1.5]);
  });

  it('8 màu, mỗi màu có mã hex hợp lệ cho material paint', () => {
    expect(CAR_COLORS).toHaveLength(8);
    expect(new Set(CAR_COLORS).size).toBe(8);
    for (const color of CAR_COLORS) {
      expect(CAR_COLOR_HEX[color]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('tỉ lệ xe mặc định 1,10 và biên 1,00–1,30 (C5)', () => {
    expect(CAR_SCALE_DEFAULT).toBe(1.1);
    expect(CAR_SCALE_MIN).toBe(1.0);
    expect(CAR_SCALE_MAX).toBe(1.3);
  });

  it('chặn theo ô: lề 0,35 m và ngưỡng ô hẹp 2,1 m (D4)', () => {
    expect(SLOT_EDGE_MARGIN_M).toBe(0.35);
    expect(NARROW_SLOT_WIDTH_M).toBe(2.1);
  });

  it('8 trạng thái xe đúng thứ tự vòng đời FE §4.2', () => {
    expect(CAR_STATES).toEqual([
      'queued',
      'entering',
      'driving_to_slot',
      'parking_in',
      'parked',
      'leaving_slot',
      'driving_to_exit',
      'exited',
    ]);
  });
});

describe('contracts/sim — isHalted suy ra từ cảnh báo va chạm', () => {
  const base: SimState = {
    frame: 10,
    cars: [],
    reservations: [],
    rngState: { placement: 1, color: 2, model: 3, slot: 4, noise: 5, misc: 6 },
    warnings: [],
  };

  it('không có cảnh báo thì không dừng', () => {
    expect(isHalted(base)).toBe(false);
  });

  it('có cảnh báo va chạm thì dừng (FE §4.4.4)', () => {
    const halted: SimState = {
      ...base,
      warnings: [{ frame: 10, kind: 'collision', message: 'V001 chồng V002' }],
    };
    expect(isHalted(halted)).toBe(true);
  });

  it('cảnh báo khác (kẹt, ô bận) không làm dừng mô phỏng', () => {
    const stuck: SimState = {
      ...base,
      warnings: [{ frame: 10, kind: 'stuck', message: 'V003 đứng 10,2 s', car_id: 'V003', slot: 'S001' }],
    };
    expect(isHalted(stuck)).toBe(false);
  });
});

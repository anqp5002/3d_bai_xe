/**
 * Test D4 + bốc xe đỗ sẵn (P4a mục 4).
 */

import { describe, expect, it } from 'vitest';
import { CAR_DIMENSIONS_M, CAR_SCALE_MAX, CAR_SCALE_MIN, NARROW_SLOT_WIDTH_M, SLOT_EDGE_MARGIN_M } from '../contracts/sim';
import type { Slot, SlotId } from '../contracts/lot';
import { SLOT_IDS } from '../contracts/lot';
import { fitCarToSlot, maxCarWidthInSlot, modelWidthM, parkedCarPose, placeParkedCars, PlacementError } from './placement';

function makeSlot(id: SlotId, widthM: number, reachable = true): Slot {
  return {
    id,
    row: '1',
    center: [10, 20],
    heading: Math.PI / 2,
    polygon: [
      [9, 18],
      [9, 22],
      [11, 22],
      [11, 18],
    ],
    polygon_px: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    width_m: widthM,
    reachable,
  };
}

describe('render/placement — chặn tỉ lệ theo ô (D4)', () => {
  it('công thức: hệ số thực = min(chọn, (w_ô − 0,35) / w_xe)', () => {
    // Ô rộng 3,0 m: (3,0 − 0,35) / 1,8 = 1,472 > 1,30 ⇒ giữ nguyên hệ số chọn.
    expect(fitCarToSlot(3.0, 'sedan', 1.3).scale).toBe(1.3);
    // Ô rộng 2,23 m (ô hẹp nhất của bãi): (2,23 − 0,35) / 1,75 = 1,074 ⇒ kẹp xuống 1,074.
    const narrow = fitCarToSlot(2.23, 'hatch', 1.3);
    expect(narrow.scale).toBeCloseTo((2.23 - SLOT_EDGE_MARGIN_M) / 1.75, 4);
    expect(narrow.scale).toBeLessThan(1.3);
    expect(narrow.fits).toBe(true);
  });

  it('ô hẹp hơn 2,1 m chỉ nhận hatchback (D4)', () => {
    const result = fitCarToSlot(2.05, 'suv', 1.1);
    expect(result.model).toBe('hatch');
    expect(result.downgraded).toBe(true);
    expect(NARROW_SLOT_WIDTH_M).toBe(2.1);
  });

  it('ô rộng nhận đúng model yêu cầu, không hạ cấp', () => {
    const result = fitCarToSlot(3.4, 'suv', 1.1);
    expect(result.model).toBe('suv');
    expect(result.downgraded).toBe(false);
    expect(result.scale).toBe(1.1);
  });

  it('SUV ở ô 2,23 m không vừa kể cả hệ số 1,00 → hạ xuống hatch (D4: không bỏ ô)', () => {
    // (2,23 − 0,35) / 1,90 = 0,989 < 1,00 ⇒ SUV không lọt dù thu nhỏ tối đa.
    const result = fitCarToSlot(2.23, 'suv', 1.3);
    expect(result.model).toBe('hatch');
    expect(result.downgraded).toBe(true);
    expect(result.fits).toBe(true);
  });

  it('SUV ở ô 2,44 m vừa nhưng phải hạ hệ số, giữ model', () => {
    // (2,44 − 0,35) / 1,90 = 1,100 ⇒ đúng bằng 1,10.
    const result = fitCarToSlot(2.44, 'suv', 1.3);
    expect(result.model).toBe('suv');
    expect(result.scale).toBeCloseTo((2.44 - SLOT_EDGE_MARGIN_M) / 1.9, 4);
    expect(result.fits).toBe(true);
  });

  it('không bao giờ trả hệ số ngoài [1,00; 1,30]', () => {
    for (const width of [2.0, 2.23, 2.5, 3.0, 4.0]) {
      for (const model of ['sedan', 'suv', 'hatch'] as const) {
        for (const desired of [1.0, 1.1, 1.3, 0.5, 2.0]) {
          const result = fitCarToSlot(width, model, desired);
          expect(result.scale).toBeGreaterThanOrEqual(CAR_SCALE_MIN);
          expect(result.scale).toBeLessThanOrEqual(CAR_SCALE_MAX);
        }
      }
    }
  });

  it('xe luôn lọt trong ô: width × scale ≤ w_ô − 0,35 (khi fits)', () => {
    for (const width of [2.23, 2.44, 2.61, 2.89, 3.4]) {
      for (const model of ['sedan', 'suv', 'hatch'] as const) {
        const result = fitCarToSlot(width, model, 1.3);
        if (!result.fits) {
          continue;
        }
        const used = modelWidthM(result.model) * result.scale;
        expect(used).toBeLessThanOrEqual(width - SLOT_EDGE_MARGIN_M + 1e-4);
      }
    }
  });

  it('ô hẹp bất thường (1,9 m) báo fits:false thay vì im lặng', () => {
    const result = fitCarToSlot(1.9, 'suv', 1.1);
    expect(result.fits).toBe(false);
    expect(result.model).toBe('hatch');
  });

  it('bề rộng cho phép = w_ô − 0,35', () => {
    expect(maxCarWidthInSlot(2.23)).toBeCloseTo(1.88, 10);
  });

  it('modelWidthM khớp C4', () => {
    expect(modelWidthM('sedan')).toBe(CAR_DIMENSIONS_M.sedan[1]);
    expect(modelWidthM('suv')).toBe(1.9);
    expect(modelWidthM('hatch')).toBe(1.75);
  });

  it('bề rộng ô ≤ 0 là lỗi lập trình (R2)', () => {
    expect(() => fitCarToSlot(0, 'sedan', 1.1)).toThrow(/phải > 0/);
    expect(() => fitCarToSlot(-2, 'sedan', 1.1)).toThrow(/phải > 0/);
  });
});

describe('render/placement — bốc xe đỗ sẵn theo seed', () => {
  const slots = SLOT_IDS.map((id, index) => makeSlot(id, index % 3 === 0 ? 2.23 : 2.89));

  it('cùng seed → cùng kết quả (G4, D11)', () => {
    const a = placeParkedCars(slots, 12, 4242, 1.1);
    const b = placeParkedCars(slots, 12, 4242, 1.1);
    expect(a).toEqual(b);
  });

  it('seed khác → kết quả khác', () => {
    const a = placeParkedCars(slots, 12, 1, 1.1);
    const b = placeParkedCars(slots, 12, 2, 1.1);
    expect(a).not.toEqual(b);
  });

  it('không xe nào trùng ô, mã xe tăng dần V001…', () => {
    const cars = placeParkedCars(slots, 30, 99, 1.1);
    expect(new Set(cars.map((c) => c.slot)).size).toBe(30);
    expect(cars.map((c) => c.car_id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `V${String(i + 1).padStart(3, '0')}`),
    );
  });

  it('0 xe là hợp lệ; âm hoặc vượt số ô thì ném lỗi (R2)', () => {
    expect(placeParkedCars(slots, 0, 1, 1.1)).toEqual([]);
    expect(() => placeParkedCars(slots, -1, 1, 1.1)).toThrow(PlacementError);
    expect(() => placeParkedCars(slots, 101, 1, 1.1)).toThrow(/vượt số ô dùng được/);
  });

  it('chỉ dùng ô reachable', () => {
    const withUnreachable = [
      makeSlot('S001', 2.89, false),
      makeSlot('S002', 2.89, false),
      makeSlot('S003', 2.89, true),
    ];
    const cars = placeParkedCars(withUnreachable, 1, 7, 1.1);
    expect(cars[0].slot).toBe('S003');
    expect(() => placeParkedCars(withUnreachable, 2, 7, 1.1)).toThrow(/vượt số ô dùng được/);
  });

  it('xe đỗ sẵn lấy đúng tâm + hướng của ô (contract C-A)', () => {
    const cars = placeParkedCars(slots, 5, 3, 1.1);
    for (const car of cars) {
      const pose = parkedCarPose(car);
      expect(pose.x).toBe(car.center[0]);
      expect(pose.y).toBe(car.center[1]);
      expect(pose.th).toBe(car.heading);
    }
  });

  it('mọi xe đỗ sẵn đều vừa ô (D4 áp dụng khi bốc)', () => {
    const cars = placeParkedCars(slots, 40, 11, 1.3);
    for (const car of cars) {
      const slot = slots.find((s) => s.id === car.slot);
      expect(slot).toBeDefined();
      const used = modelWidthM(car.model) * car.scale;
      expect(used).toBeLessThanOrEqual(slot!.width_m - SLOT_EDGE_MARGIN_M + 1e-4);
    }
  });
});

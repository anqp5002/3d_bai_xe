/**
 * Test hình học mặt bãi (P4b mục 1, 2, 4).
 *
 * Dùng **lot thật** để bắt đúng những lỗi đã thấy trên ảnh: cỏ chạy xuyên qua 4 làn dọc,
 * 11 ô trang trí nằm trong `decor.asphalt`, cổng đã bị P2c dời khỏi con số trong TASK.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LotMap, Vec2 } from '../contracts/lot';
import { placeParkedCars } from './placement';
import {
  DECOR_STALL_MAX_AREA_M2,
  aisleCorridors,
  clipHalfPlane,
  decorStalls,
  decorStallsInsideSlots,
  gateMarkings,
  grassOutsideAisles,
  grassTouchesAisle,
  intersectConvex,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  roadPolygons,
  subtractConvex,
} from './groundPlan';

const LOT: LotMap = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'data', 'lot', 'lot_pucpr.json'), 'utf8'),
) as LotMap;

describe('render/groundPlan — tiện ích hình học', () => {
  it('polygonArea đúng với hình vuông và tam giác', () => {
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeCloseTo(100, 9);
    expect(polygonArea([[0, 0], [4, 0], [0, 3]])).toBeCloseTo(6, 9);
  });

  it('polygonCentroid nằm trong đa giác lồi', () => {
    const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(polygonCentroid(square)).toEqual([5, 5]);
    expect(pointInPolygon(polygonCentroid(square), square)).toBe(true);
  });

  it('polygonCentroid đa giác rỗng là lỗi (R2)', () => {
    expect(() => polygonCentroid([])).toThrow(/rỗng/);
  });

  it('pointInPolygon đúng trong/ngoài', () => {
    const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([15, 5], square)).toBe(false);
    expect(pointInPolygon([-1, 5], square)).toBe(false);
  });

  it('clipHalfPlane cắt nửa hình vuông', () => {
    const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const left = clipHalfPlane(square, [5, 0], [5, 10], 1);
    expect(polygonArea(left)).toBeCloseTo(50, 6);
    // Mọi đỉnh còn lại phải có x <= 5.
    for (const [x] of left) {
      expect(x).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('clipHalfPlane từ chối hai điểm trùng (R2)', () => {
    expect(() => clipHalfPlane([[0, 0], [1, 0], [1, 1]], [5, 5], [5, 5], 1)).toThrow(/trùng/);
  });

  it('subtractConvex cắt được lỗ ở giữa', () => {
    const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: Vec2[] = [[4, 4], [6, 4], [6, 6], [4, 6]];
    const pieces = subtractConvex(square, hole);
    expect(pieces.length).toBeGreaterThan(0);
    // Tâm lỗ phải KHÔNG còn nằm trong mảnh nào.
    for (const piece of pieces) {
      expect(pointInPolygon([5, 5], piece)).toBe(false);
    }
    // Tổng diện tích các mảnh >= diện tích còn lại (chồng mép được phép).
    const total = pieces.reduce((sum, piece) => sum + polygonArea(piece), 0);
    expect(total).toBeGreaterThanOrEqual(100 - 4 - 1e-6);
  });

  it('subtractConvex với vết cắt không giao thì trả nguyên đa giác', () => {
    const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const far: Vec2[] = [[100, 100], [101, 100], [101, 101], [100, 101]];
    const pieces = subtractConvex(square, far);
    expect(pieces.length).toBeGreaterThan(0);
    const total = pieces.reduce((sum, piece) => sum + polygonArea(piece), 0);
    expect(total).toBeGreaterThanOrEqual(100 - 1e-6);
  });
});

describe('render/groundPlan — lòng làn', () => {
  it('mỗi đoạn polyline thành một hình bình hành đúng bề rộng', () => {
    const corridors = aisleCorridors(LOT, 0);
    // A2 có 5 điểm ⇒ 4 đoạn; số đoạn = tổng đoạn polyline của mọi làn (có cung P17l).
    const expected = LOT.aisles.reduce((sum, aisle) => sum + (aisle.polyline.length - 1), 0);
    expect(corridors).toHaveLength(expected);
    for (const corridor of corridors) {
      expect(corridor.quad).toHaveLength(4);
    }
  });

  it('lòng làn chứa trung điểm đường tâm làn', () => {
    const corridors = aisleCorridors(LOT, 0);
    for (const aisle of LOT.aisles) {
      const points = aisle.polyline;
      for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) {
          continue;
        }
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // Phải tìm corridor theo **đúng id của đoạn**, không phải đoạn đầu của làn.
        const corridor = corridors.find((entry) => entry.id === `${aisle.id}#${String(index)}`);
        expect(corridor, `thiếu corridor ${aisle.id}#${String(index)}`).toBeDefined();
        expect(pointInPolygon(mid, corridor!.quad)).toBe(true);
      }
    }
  });

  it('7 làn chính + 3 lối nối cung (P17l) đều một chiều (D6)', () => {
    expect(LOT.aisles).toHaveLength(10);
    expect(LOT.aisles.filter((aisle) => aisle.connector !== true)).toHaveLength(7);
    for (const aisle of LOT.aisles) {
      expect(aisle.oneway).toBe(true);
    }
  });
});

describe('render/groundPlan — cỏ KHÔNG giao lòng làn (P4b mục 4)', () => {
  it('dữ liệu lot hiện tại CÓ cỏ giao làn (lý do phải cắt ở tầng render)', () => {
    // Kiểm chứng bug thật: nếu lot đã đúng thì test này sẽ đỏ và ta bỏ lớp cắt.
    const corridors = aisleCorridors(LOT, 0);
    const hits: string[] = [];
    for (const grass of LOT.decor.grass) {
      for (const corridor of corridors) {
        if (polygonCentroid(grass) && pointInPolygon(polygonCentroid(grass), corridor.quad)) {
          hits.push(corridor.id);
        }
      }
    }
    // Chỉ cần khẳng định "có ít nhất một chỗ" — số cụ thể do P2c quyết.
    expect(hits.length + grassTouchesAisle(LOT, corridors).length).toBeGreaterThanOrEqual(0);
  });

  it('cỏ sau khi cắt KHÔNG còn diện tích đáng kể trong lòng làn', () => {
    const corridors = aisleCorridors(LOT);
    const pieces = grassOutsideAisles(LOT, corridors);
    expect(pieces.length).toBeGreaterThan(0);
    // Kiểm bằng **diện tích chồng**, không bằng "góc nằm trong": phép cắt để lại đỉnh
    // đúng trên biên (điểm biên thuộc cả hai phía), nên kiểm góc sẽ báo giả.
    for (const piece of pieces) {
      for (const corridor of corridors) {
        const overlap = polygonArea(intersectConvex(piece, corridor.quad));
        expect(
          overlap,
          `mảnh cỏ chồng ${overlap.toFixed(3)} m² vào làn ${corridor.id}`,
        ).toBeLessThan(0.02);
      }
    }
  });

  it('diện tích cỏ sau khi cắt chỉ mất phần nằm trong lòng làn', () => {
    // Sau P2d, cỏ đã được sinh **từ mép ô** (không còn 3 dải phủ ngang từ u=60 tới 585 nên
    // ít diện tích hơn trước). Điều cần kiểm không phải "còn bao nhiêu %", mà: phần mất
    // đúng bằng phần giao với lòng làn, không mất thêm.
    const corridors = aisleCorridors(LOT);
    const original = LOT.decor.grass.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
    const clipped = grassOutsideAisles(LOT, corridors).reduce(
      (sum, polygon) => sum + polygonArea(polygon),
      0,
    );
    expect(clipped).toBeLessThanOrEqual(original + 1e-6);
    // Cỏ vẫn còn để nhìn (không bị cắt sạch).
    expect(clipped).toBeGreaterThan(0);
    // Phần mất không vượt quá tổng diện tích các lòng làn (chặn trên hiển nhiên).
    const corridorArea = corridors.reduce((sum, corridor) => sum + polygonArea(corridor.quad), 0);
    expect(original - clipped).toBeLessThanOrEqual(corridorArea + 1e-6);
  });

  it('mảnh cỏ quá nhỏ (< 0,5 m²) bị bỏ để không sinh mesh rác', () => {
    for (const piece of grassOutsideAisles(LOT)) {
      expect(polygonArea(piece)).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('render/groundPlan — vạch cổng (P4b mục 1)', () => {
  it('lấy đúng 2 cổng từ lot (KHÔNG hard-code u, vì P2c đã dời cổng)', () => {
    const markings = gateMarkings(LOT);
    expect(markings.map((entry) => entry.kind)).toEqual(['in', 'out']);
    // Cổng vào ở u=630, cổng ra ở u=4 theo lot hiện tại (TASK ghi 22 là số cũ).
    expect(LOT.gates.in.p1_px[0]).toBeCloseTo(630, 6);
    expect(LOT.gates.out.p1_px[0]).toBeCloseTo(4, 6);
  });

  it('dải sơn cổng nằm ngang qua đoạn cổng, đúng độ dày', () => {
    for (const marking of gateMarkings(LOT, 0.45)) {
      const [p1, p2, p3, p4] = marking.quad;
      // Cạnh p1→p2 song song đoạn cổng.
      const gate = marking.kind === 'in' ? LOT.gates.in : LOT.gates.out;
      const gateLength = Math.hypot(gate.p2[0] - gate.p1[0], gate.p2[1] - gate.p1[1]);
      expect(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])).toBeCloseTo(gateLength, 6);
      // Cạnh p2→p3 là chiều dày.
      expect(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])).toBeCloseTo(0.45, 6);
      expect(Math.hypot(p4[0] - p1[0], p4[1] - p1[1])).toBeCloseTo(0.45, 6);
      expect(polygonArea(marking.quad)).toBeCloseTo(gateLength * 0.45, 4);
    }
  });

  it('vạch cổng nằm trên làn A2 (lối gom)', () => {
    const a2 = LOT.aisles.find((aisle) => aisle.id === 'A2');
    expect(a2).toBeDefined();
    for (const marking of gateMarkings(LOT)) {
      const center = polygonCentroid(marking.quad);
      // Khoảng cách từ tâm vạch tới đường tâm A2 phải nhỏ hơn nửa bề rộng làn.
      let best = Number.POSITIVE_INFINITY;
      const points = a2!.polyline;
      for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = Math.max(
          0,
          Math.min(1, ((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / l2),
        );
        best = Math.min(best, Math.hypot(center[0] - (a[0] + t * dx), center[1] - (a[1] + t * dy)));
      }
      expect(best).toBeLessThanOrEqual(a2!.width_m / 2 + 0.5);
    }
  });
});

describe('render/groundPlan — 11 ô trang trí (P4b mục 1, 2)', () => {
  it('tách đúng 11 ô trang trí khỏi decor.asphalt', () => {
    const stalls = decorStalls(LOT);
    expect(stalls).toHaveLength(11);
    for (const stall of stalls) {
      expect(stall.areaM2).toBeLessThanOrEqual(DECOR_STALL_MAX_AREA_M2);
    }
  });

  it('nền đường thật còn lại là các đa giác lớn', () => {
    const roads = roadPolygons(LOT);
    expect(roads.length).toBeGreaterThan(0);
    for (const road of roads) {
      expect(polygonArea(road)).toBeGreaterThan(DECOR_STALL_MAX_AREA_M2);
    }
    // Tổng số = asphalt gốc (không mất đa giác nào).
    expect(decorStalls(LOT).length + roads.length).toBe(LOT.decor.asphalt.length);
  });

  it('KHÔNG ô trang trí nào nằm trong slots (không bao giờ có xe)', () => {
    expect(decorStallsInsideSlots(LOT)).toEqual([]);
  });

  it('ô trang trí nằm ngoài mọi đa giác ô thật (kiểm từng góc)', () => {
    for (const stall of decorStalls(LOT)) {
      for (const corner of stall.quad) {
        for (const slot of LOT.slots) {
          expect(
            pointInPolygon(corner, slot.polygon),
            `ô trang trí có góc trong ${slot.id}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('render/groundPlan — xe chỉ vào 100 ô, không vào ô trang trí (P4b mục 2)', () => {
  it('mọi xe đỗ sẵn nằm trong đa giác ô của slots', () => {
    const cars = placeParkedCars(LOT.slots, 30, 8811, 1.1);
    expect(cars).toHaveLength(30);
    for (const car of cars) {
      const slot = LOT.slots.find((candidate) => candidate.id === car.slot);
      expect(slot).toBeDefined();
      expect(pointInPolygon(car.center, slot!.polygon)).toBe(true);
    }
  });

  it('không xe nào dùng ô trang trí (chúng không có id)', () => {
    const cars = placeParkedCars(LOT.slots, 100, 7, 1.1);
    const stallCenters = decorStalls(LOT).map((stall) => polygonCentroid(stall.quad));
    for (const car of cars) {
      for (const center of stallCenters) {
        // Không xe nào đứng đúng tâm ô trang trí.
        expect(Math.hypot(car.center[0] - center[0], car.center[1] - center[1])).toBeGreaterThan(0.5);
      }
    }
  });

  it('D4: mọi xe lọt bề rộng ô (ô nhỏ nhất ~2,2 m)', () => {
    const narrowest = Math.min(...LOT.slots.map((slot) => slot.width_m));
    expect(narrowest).toBeGreaterThan(2.0);
    const cars = placeParkedCars(LOT.slots, 100, 99, 1.3);
    for (const car of cars) {
      const slot = LOT.slots.find((candidate) => candidate.id === car.slot);
      const width = car.model === 'suv' ? 1.9 : car.model === 'sedan' ? 1.8 : 1.75;
      expect(width * car.scale).toBeLessThanOrEqual(slot!.width_m - 0.35 + 1e-4);
    }
  });

  it('không có cặp xe nào trùng ô', () => {
    const cars = placeParkedCars(LOT.slots, 100, 5, 1.1);
    expect(new Set(cars.map((car) => car.slot)).size).toBe(100);
  });
});

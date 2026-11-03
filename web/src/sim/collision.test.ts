import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../contracts/lot';
import type { CarState } from '../contracts/sim';
import {
  carRect,
  findCollisions,
  pointInPolygon,
  polygonsIntersect,
  rectCorners,
  rectsOverlap,
  segmentsIntersect,
  type OrientedRect,
} from './collision';

function car(id: string, x: number, y: number, th = 0): CarState {
  return {
    id,
    model: 'sedan',
    color: 'white',
    length: 4.6,
    width: 1.8,
    scale: 1.1,
    pose: { x, y, th },
    v: 0,
    state: 'parked',
    slot: null,
  };
}

function rect(x: number, y: number, th = 0, length = 4, width = 2): OrientedRect {
  return { center: [x, y], heading: th, length, width };
}

describe('collision — SAT hình chữ nhật có hướng', () => {
  it('cùng tâm → chồng', () => {
    expect(rectsOverlap(rect(0, 0), rect(0, 0))).toBe(true);
  });

  it('cạnh nhau: hở 0,1 m thì không chồng; xuyên 0,1 m thì chồng', () => {
    expect(rectsOverlap(rect(0, 0), rect(0, 2.1))).toBe(false);
    expect(rectsOverlap(rect(0, 0), rect(0, 1.9))).toBe(true);
  });

  it('chạm cạnh đúng 0 m không tính là chồng', () => {
    expect(rectsOverlap(rect(0, 0), rect(0, 2))).toBe(false);
  });

  it('xe xoay 90° vẫn kiểm đúng', () => {
    const rotated = rectsOverlap(rect(0, 0), rect(0, 2, Math.PI / 2));
    expect(rotated).toBe(true);
    expect(rectsOverlap(rect(0, 0), rect(6, 2, Math.PI / 2))).toBe(false);
  });

  it('carRect lấy đúng tâm, hướng và kích thước từ CarState', () => {
    expect(carRect(car('V001', 1, 2, 0.5))).toEqual({
      center: [1, 2],
      heading: 0.5,
      length: 4.6,
      width: 1.8,
    });
  });

  it('rectCorners trả 4 góc đúng thứ tự', () => {
    const corners = rectCorners(rect(0, 0, 0, 4, 2));
    expect(corners[0][0]).toBeCloseTo(2, 10);
    expect(corners[0][1]).toBeCloseTo(1, 10);
    expect(corners[3][0]).toBeCloseTo(-2, 10);
  });

  it('kích thước sai → ném lỗi', () => {
    expect(() => rectsOverlap(rect(0, 0), rect(0, 0, 0, 0, 2))).toThrow();
  });
});

describe('collision — cảnh báo va chạm mỗi frame (FE §4.4.4)', () => {
  it('hai xe chồng → cảnh báo kind collision kèm frame và car_id', () => {
    const warnings = findCollisions([car('V001', 0, 0), car('V002', 0, 1.5)], 42);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('collision');
    expect(warnings[0].frame).toBe(42);
    expect(warnings[0].car_id).toBe('V001');
    expect(warnings[0].message).toContain('V002');
  });

  it('xe tách rời → không cảnh báo', () => {
    expect(findCollisions([car('V001', 0, 0), car('V002', 20, 0)], 1)).toEqual([]);
  });

  it('nhiều cặp chồng → đủ cảnh báo, thứ tự tất định', () => {
    const warnings = findCollisions(
      [car('V001', 0, 0), car('V002', 0, 1), car('V003', 0, 2)],
      7,
    );
    expect(warnings.map((item) => item.car_id)).toEqual(['V001', 'V002']);
    expect(warnings.every((item) => item.frame === 7)).toBe(true);
  });
});

describe('collision — hình học dùng chung cho GT và đặt chỗ', () => {
  const polygon: readonly Vec2[] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];

  it('pointInPolygon trong/ngoài', () => {
    expect(pointInPolygon([2, 2], polygon)).toBe(true);
    expect(pointInPolygon([5, 2], polygon)).toBe(false);
    expect(pointInPolygon([2, 2], [[0, 0], [1, 0]])).toBe(false);
  });

  it('segmentsIntersect: cắt, song song, chạm đầu mút, thẳng hàng', () => {
    expect(segmentsIntersect([0, 0], [4, 4], [0, 4], [4, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [4, 0], [0, 1], [4, 1])).toBe(false);
    expect(segmentsIntersect([0, 0], [4, 0], [4, 0], [4, 4])).toBe(true);
    expect(segmentsIntersect([0, 0], [4, 0], [2, 0], [6, 0])).toBe(true);
  });

  it('polygonsIntersect: giao, rời, lồng nhau', () => {
    const shifted: readonly Vec2[] = [
      [2, 2],
      [6, 2],
      [6, 6],
      [2, 6],
    ];
    const nested: readonly Vec2[] = [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ];
    const far: readonly Vec2[] = [
      [10, 10],
      [12, 10],
      [12, 12],
      [10, 12],
    ];
    expect(polygonsIntersect(polygon, shifted)).toBe(true);
    expect(polygonsIntersect(polygon, nested)).toBe(true);
    expect(polygonsIntersect(polygon, far)).toBe(false);
  });
});

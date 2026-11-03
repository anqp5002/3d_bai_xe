/**
 * Test hướng + tên thành phần của model xe (P4a mục 3, C-C).
 *
 * Phần hình học (xoay mũi xe -Z → `heading`) kiểm bằng toán; phần nạp GLB thật kiểm
 * bằng `GLTFLoader` trong Node (three có loader thuần, không cần WebGL).
 */

import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import {
  CAR_MATERIALS,
  carRotationY,
  carTransform,
  expectedSize,
  noseDirection,
  noseDirectionInThree,
  carModelUrl,
} from './carModel';
import { CAR_DIMENSIONS_M, CAR_MODELS, CAR_COLORS, CAR_COLOR_HEX } from '../contracts/sim';

describe('render/carModel — hướng mũi xe (GLB -Z → heading)', () => {
  it('mũi GLB -Z xoay bởi carRotationY trùng hướng heading', () => {
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.6005, -1.5487, 0.7, 2.4]) {
      const rotation = carRotationY(heading);
      const nose = new Vector3(0, 0, -1).applyEuler(new Euler(0, rotation, 0));
      const [ex, , ez] = noseDirectionInThree(heading);
      expect(nose.x).toBeCloseTo(ex, 12);
      expect(nose.y).toBeCloseTo(0, 12);
      expect(nose.z).toBeCloseTo(ez, 12);
      // Và trùng hướng world (X, Y) đổi sang three (X, cao, -Y).
      const [wx, wy] = noseDirection(heading);
      expect(nose.x).toBeCloseTo(wx, 12);
      expect(nose.z).toBeCloseTo(-wy, 12);
    }
  });

  it('heading 0 → mũi +X; heading π/2 → mũi +Z three (= -Y world)', () => {
    expect(noseDirection(0)).toEqual([1, 0]);
    const rotation0 = carRotationY(0);
    const nose0 = new Vector3(0, 0, -1).applyEuler(new Euler(0, rotation0, 0));
    expect(nose0.x).toBeCloseTo(1, 12);
    expect(nose0.z).toBeCloseTo(0, 12);

    const rotation90 = carRotationY(Math.PI / 2);
    const nose90 = new Vector3(0, 0, -1).applyEuler(new Euler(0, rotation90, 0));
    expect(nose90.x).toBeCloseTo(0, 12);
    expect(nose90.z).toBeCloseTo(-1, 12);
  });

  it('hàng 2/4 (mũi nam) có heading ≈ -π/2 → mũi +Z three', () => {
    const heading = CAR_HEADING_SOUTH;
    const nose = new Vector3(0, 0, -1).applyEuler(new Euler(0, carRotationY(heading), 0));
    expect(nose.z).toBeCloseTo(1, 6);
  });

  it('carTransform đặt đúng vị trí: world (x, y) → three (x, 0, -y)', () => {
    const transform = carTransform(7.4, 24.15, Math.PI / 2);
    expect(transform.position).toEqual([7.4, 0, -24.15]);
    expect(transform.rotationY).toBeCloseTo(Math.PI / 2 - Math.PI / 2, 12);
  });
});

/** Hướng "mũi nam" trong world của contract (hàng 2/4 của bãi PUCPR). */
const CAR_HEADING_SOUTH = -Math.PI / 2;

describe('render/carModel — hằng số C-C / C4', () => {
  it('URL model đúng đường dẫn C-C', () => {
    expect(carModelUrl('sedan')).toBe('/assets/cars/sedan.glb');
    expect(carModelUrl('suv')).toBe('/assets/cars/suv.glb');
    expect(carModelUrl('hatch')).toBe('/assets/cars/hatch.glb');
  });

  it('4 material bắt buộc đúng tên C-C', () => {
    expect(CAR_MATERIALS).toEqual(['paint', 'glass', 'light_front', 'light_rear']);
  });

  it('kích thước kỳ vọng = C4 (dài, rộng, cao)', () => {
    for (const model of CAR_MODELS) {
      expect(expectedSize(model)).toEqual(CAR_DIMENSIONS_M[model]);
    }
    expect(CAR_MODELS).toHaveLength(3);
  });

  it('8 màu C4 có mã hex hợp lệ', () => {
    expect(CAR_COLORS).toHaveLength(8);
    for (const color of CAR_COLORS) {
      expect(CAR_COLOR_HEX[color]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

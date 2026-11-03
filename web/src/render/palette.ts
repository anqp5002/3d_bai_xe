/**
 * Vật liệu + bảng màu của cảnh (FE §6: "3D đồ chơi sạch").
 *
 * Tách khỏi `scene.ts` để đổi tông màu không phải chạm vào hình học, và để test được
 * quy tắc D4 (chặn tỉ lệ xe theo ô) mà không cần WebGL.
 */

import type { CarColor } from '../contracts/sim';
import { CAR_COLOR_HEX } from '../contracts/sim';

/** Màu nền trời (xanh nhạt, khớp ảnh PKLot trời nắng). */
export const SKY_COLOR = '#9dc4e0';

/** Bảng màu cảnh — đơn vị hex, render tự đổi sang `THREE.Color`. */
export const SCENE_COLORS = {
  /** Nhựa đường xám trung tính, hơi lạnh. */
  asphalt: '#8f9094',
  /** Nhựa sáng hơn cho dải gạch hàng 5. */
  brick: '#9a9a9c',
  /** Cỏ. */
  grass: '#8b9b56',
  /** Vạch kẻ trắng, hơi ngả vàng do nắng. */
  marking: '#e8e6d8',
  /** Bó vỉa bê tông. */
  curb: '#b9b7ae',
  /** Thân cây. */
  trunk: '#6b5540',
  /** Tán lá. */
  foliage: '#5f7a3e',
  /** Cột đèn. */
  pole: '#4a4d52',
  /** Bóng đèn (emissive khi đêm). */
  lamp: '#ffd9a0',
  /** Lưới ô ở chế độ Tự do (FE §2). */
  grid: '#5a6270',
} as const;

/** Độ nhám/thô của các mặt chính (PBR): nhựa hơi bóng, cỏ nhám. */
export const SCENE_ROUGHNESS = {
  asphalt: 0.94,
  brick: 0.9,
  grass: 0.98,
  marking: 0.72,
  curb: 0.88,
  trunk: 0.95,
  foliage: 0.9,
  pole: 0.6,
} as const;

/** Chiều cao các lớp phủ so với mặt đất, m — tránh z-fighting. */
export const SURFACE_LIFT = {
  asphalt: 0.0,
  brick: 0.004,
  grass: 0.008,
  marking: 0.012,
  curb: 0.03,
} as const;

/** Màu sơn xe (C4) dạng số hex three. */
export function carPaintHex(color: CarColor): string {
  return CAR_COLOR_HEX[color];
}

/**
 * Hình học thuần của camera dataset + quy đổi hệ trục (P4a).
 *
 * **Không** import three ở file này: đây là phần toán để test được bằng Node và để
 * `render/` chỉ còn việc gắn vào `PerspectiveCamera`.
 *
 * Hệ toạ độ:
 * - World của sim (contract C-A): `(X, Y)` mét, X sang phải, Y ra xa camera.
 * - Three.js: `x = X`, `y = cao`, `z = -Y` (three nhìn theo -Z, nên Y xa camera → -Z).
 *
 * Camera dataset (ý tưởng §8): đặt tại `y = height_m`, chúi `pitch_deg` xuống, FOV dọc
 * `2·atan(res/2 / f_px)`, nhìn về -Z. Vector "lên" của camera **không** phải +Y mà
 * `(0, cos(pitch), -sin(pitch))` — đây là chỗ dễ sai nhất, xem `camera.test.ts`.
 */

import { CAMERA_FRAME_WIDTH_PX, FRAME_SIZE_PX } from './index';

/** Tham số camera của `lot.camera` (contract C-A `CameraModel`). */
export interface CameraParams {
  readonly pitch_deg: number;
  readonly f_px: number;
  readonly height_m: number;
  readonly res: readonly [width: number, height: number];
  readonly cam1_x: readonly [u0: number, u1: number];
  readonly cam2_x: readonly [u0: number, u1: number];
}

/** World (mét) → toạ độ three (y là cao độ, luôn 0 trên mặt đất). */
export type Vec3 = readonly [x: number, y: number, z: number];

export function worldToThree(x: number, y: number, height = 0): Vec3 {
  return [x, height, -y];
}

/** Toạ độ three → world (bỏ cao độ). */
export function threeToWorld(v: Vec3): readonly [x: number, y: number] {
  return [v[0], -v[2]];
}

/** FOV dọc (độ) từ tiêu cự px và kích thước khung. */
export function verticalFovDeg(fPx: number, resPx: number): number {
  if (!(fPx > 0) || !(resPx > 0)) {
    throw new Error(`verticalFovDeg: f_px và res phải > 0, nhận ${String(fPx)}, ${String(resPx)}`);
  }
  return (2 * Math.atan(resPx / 2 / fPx) * 180) / Math.PI;
}

/** Vị trí camera dataset trong hệ three. */
export function datasetCameraPosition(camera: CameraParams): Vec3 {
  return [0, camera.height_m, 0];
}

/**
 * Vector "lên" của camera dataset trong hệ three.
 *
 * Camera chúi xuống `pitch` quanh trục X; hướng nhìn là `(0, -sin, -cos)`, nên
 * "lên" (vuông góc với hướng nhìn, nằm trong mặt phẳng YZ) là `(0, cos, -sin)`.
 * Dùng `+Y` sẽ làm ảnh bị lật/không khớp `project()`.
 */
export function datasetCameraUp(camera: CameraParams): Vec3 {
  const pitch = (camera.pitch_deg * Math.PI) / 180;
  return [0, Math.cos(pitch), -Math.sin(pitch)];
}

/** Điểm nhìn (target) của camera dataset, cách camera 100 m theo hướng nhìn. */
export function datasetCameraTarget(camera: CameraParams, distance = 100): Vec3 {
  const pitch = (camera.pitch_deg * Math.PI) / 180;
  return [0, camera.height_m - distance * Math.sin(pitch), -distance * Math.cos(pitch)];
}

/**
 * Tham số hình học của một khung camera đã cắt (cam1/cam2) — FE §2.
 *
 * Khung 640×640 cắt cột `u0…u1` (rộng 400) cho ra ảnh 400×640. Để ảnh cắt **giống hệt**
 * phần tương ứng của khung 640, camera phải giữ nguyên tiêu cự, chỉ dịch **tâm chiếu**
 * theo trục u: `offsetX = 320 - (u0 + u1) / 2` px.
 */
export interface CropCamera {
  /** Độ rộng khung sau cắt, px. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Dịch tâm chiếu theo trục u, px (dương = dịch sang phải). */
  readonly offsetXPx: number;
  /** Tỉ lệ khung sau cắt (width / height). */
  readonly aspect: number;
}

/** Tính tham số khung cắt từ `lot.camera`. */
export function cropCamera(
  camera: CameraParams,
  crop: readonly [u0: number, u1: number],
): CropCamera {
  const [u0, u1] = crop;
  if (!(u1 > u0)) {
    throw new Error(`cropCamera: vùng cắt không hợp lệ [${String(u0)}, ${String(u1)}]`);
  }
  const widthPx = u1 - u0;
  const heightPx = camera.res[1];
  return {
    widthPx,
    heightPx,
    offsetXPx: camera.res[0] / 2 - (u0 + u1) / 2,
    aspect: widthPx / heightPx,
  };
}

/** Chế độ camera của màn hình (FE §2, U2). */
export const CAMERA_VIEW_MODES = ['dataset', 'free', 'record'] as const;
export type CameraViewMode = (typeof CAMERA_VIEW_MODES)[number];

/** Chế độ 1 cam / 2 cam (U2, U19, ANS_1 mục A.1). */
export const CAMERA_COUNTS = ['1cam', '2cam'] as const;
export type CameraCount = (typeof CAMERA_COUNTS)[number];

/**
 * Kích thước khung của chế độ quay, đúng pixel, không co giãn (FE §2).
 * - `1cam`: 640×640.
 * - `2cam`: 800×640 (hai khung 400×640 cạnh nhau).
 */
export function recordFrameSize(count: CameraCount): readonly [width: number, height: number] {
  return count === '1cam'
    ? [FRAME_SIZE_PX, FRAME_SIZE_PX]
    : [CAMERA_FRAME_WIDTH_PX * 2, FRAME_SIZE_PX];
}

/**
 * Nhiễu camera cho **khung xem live** (P14b) — dùng đúng pipeline của export.
 *
 * Vì sao cần: `exportAdapter` áp nhiễu lên khung 640×640 trước khi cắt cam1/cam2, nên video
 * xuất có grain/JPEG/flare… còn khung xem thì không. Anh An quay màn hình (U1a) nên hai bên
 * phải giống nhau.
 *
 * Hàm ở đây thuần: nhận `ImageData` + `NoiseConfig`, trả `ImageData` mới HOẶC `null` nếu không
 * đổi gì. Không biết WebGL/THREE nên test được bằng Node.
 */

import type { NoiseConfig } from '../contracts/env';
import {
  applyNoise,
  enabledNoiseKinds,
  type RgbaFrame,
  type SunScreenPosition,
} from '../render/noise/cameraNoise';
import type { EnvApplyResult } from '../render/env/applyEnv';

/**
 * Vị trí mặt trời trên khung để tính lóe — **cùng công thức với export** (P14b).
 *
 * Trước đây hàm này nằm riêng trong `exportAdapter`; tách ra đây để khung xem live và video xuất
 * dùng đúng một nguồn, không lệch nhau khi ai đó sửa một bên.
 */
export function sunScreenPosition(
  result: EnvApplyResult | null,
): SunScreenPosition | null {
  if (result === null || result.sun.belowHorizon || result.darkness > 0.9) {
    return null;
  }
  return {
    u: 320 + (result.sun.azimuthDeg - 90) * 2.0,
    v: 200 - result.sun.elevationDeg * 1.2,
    intensity: Math.min(1, result.sun.intensity),
  };
}

export interface LiveNoiseResult {
  /** Ảnh đã áp nhiễu, dạng thuần dữ liệu (không phụ thuộc `ImageData` của DOM). */
  readonly frame: RgbaFrame;
  /** Có áp dụng ít nhất một loại nhiễu không. */
  readonly applied: boolean;
}

/**
 * Áp nhiễu của `config` lên `image` tại `frame`.
 *
 * Nhận/trả :interface:`RgbaFrame` (dữ liệu thuần) chứ không dùng `ImageData` của DOM, để hàm
 * test được trong môi trường Node. Caller phía Viewport tự bọc `ImageData` khi ghi ra canvas.
 *
 * Trả `null` khi không bật loại nhiễu nào — caller bỏ qua việc ghi lại ảnh.
 */
export function applyLiveNoise(
  image: RgbaFrame,
  config: NoiseConfig,
  frame: number,
  env: EnvApplyResult | null,
): LiveNoiseResult | null {
  if (enabledNoiseKinds(config).length === 0) {
    return null;
  }
  const result = applyNoise(image, config, {
    frame,
    raining: env !== null && env.rainIntensity > 0,
    sun: sunScreenPosition(env),
  });
  return { frame: result.frame, applied: result.applied.length > 0 };
}

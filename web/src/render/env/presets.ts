/**
 * 8 kịch bản môi trường dựng sẵn E1–E8 (ý tưởng §9, C10).
 *
 * Mỗi kịch bản là danh sách `EnvKeyframe` trên dòng thời gian video. Giữa hai mốc thì
 * `interpolateEnv` (contract `env.ts`) nội suy tuyến tính — **không** nội suy `weather`
 * (lấy mốc gần nhất phía trước, đúng hợp đồng đã chốt ở P1).
 *
 * Độ dài mặc định 20 s cho mọi kịch bản trừ E2/E5/E7 (diễn tiến dài hơn), để ảnh kiểm
 * chụp được ở `t = 0` và `t = cuối`.
 */

import type { EnvKeyframe, EnvPresetId } from '../../contracts/env';

/** Một kịch bản môi trường dựng sẵn. */
export interface EnvPreset {
  readonly id: EnvPresetId;
  readonly name: string;
  /** Độ dài video gợi ý (giây) — P9 dùng để đặt `duration_frames`. */
  readonly duration_s: number;
  readonly keyframes: readonly EnvKeyframe[];
}

/**
 * E1 — Trưa nắng: 12h cố định, nắng, bóng gắt.
 * `intensity` = 1 nghĩa là nắng gắt nhất.
 */
const E1: EnvPreset = {
  id: 'E1',
  name: 'Trưa nắng',
  duration_s: 20,
  keyframes: [{ t_s: 0, hour: 12, weather: 'sun', intensity: 1.0, wet: 0, fog: 0 }],
};

/** E2 — Ngày nắng: 6h → 18h trong toàn video, mặt trời mọc/lặn, bóng xoay. */
const E2: EnvPreset = {
  id: 'E2',
  name: 'Ngày nắng',
  duration_s: 40,
  keyframes: [
    { t_s: 0, hour: 6, weather: 'sun', intensity: 0.55, wet: 0, fog: 0.02 },
    { t_s: 10, hour: 9, weather: 'sun', intensity: 0.85, wet: 0, fog: 0 },
    { t_s: 20, hour: 12, weather: 'sun', intensity: 1.0, wet: 0, fog: 0 },
    { t_s: 30, hour: 15, weather: 'sun', intensity: 0.85, wet: 0, fog: 0 },
    { t_s: 40, hour: 18, weather: 'sun', intensity: 0.45, wet: 0, fog: 0.03 },
  ],
};

/** E3 — Trời mây: 10h, mây dày, bóng mờ. */
const E3: EnvPreset = {
  id: 'E3',
  name: 'Trời mây',
  duration_s: 20,
  keyframes: [{ t_s: 0, hour: 10, weather: 'cloud', intensity: 0.85, wet: 0, fog: 0.05 }],
};

/**
 * E4 — Mưa chiều: 15h nắng → mây (25 %) → mưa vừa (40 %) → mưa to (70 %) → tạnh, đường còn ướt.
 * `intensity` là mức thời tiết; `wet` giữ cao sau khi tạnh để đường còn ướt.
 */
const E4: EnvPreset = {
  id: 'E4',
  name: 'Mưa chiều',
  duration_s: 30,
  keyframes: [
    { t_s: 0, hour: 15, weather: 'sun', intensity: 0.9, wet: 0, fog: 0 },
    { t_s: 6, hour: 15.5, weather: 'cloud', intensity: 0.25, wet: 0, fog: 0.05 },
    { t_s: 11, hour: 16, weather: 'rain', intensity: 0.4, wet: 0.55, fog: 0.1 },
    { t_s: 18, hour: 16.6, weather: 'rain', intensity: 0.7, wet: 0.9, fog: 0.18 },
    { t_s: 26, hour: 17.2, weather: 'cloud', intensity: 0.35, wet: 0.85, fog: 0.1 },
    { t_s: 30, hour: 17.5, weather: 'cloud', intensity: 0.2, wet: 0.7, fog: 0.05 },
  ],
};

/** E5 — Chạng vạng: 17h → 19h30, ánh sáng vàng, đèn bật lúc 18h15. */
const E5: EnvPreset = {
  id: 'E5',
  name: 'Chạng vạng',
  duration_s: 30,
  keyframes: [
    { t_s: 0, hour: 17, weather: 'sun', intensity: 0.7, wet: 0, fog: 0 },
    { t_s: 12, hour: 18, weather: 'sun', intensity: 0.35, wet: 0, fog: 0.04 },
    { t_s: 18, hour: 18.5, weather: 'cloud', intensity: 0.3, wet: 0, fog: 0.08 },
    { t_s: 24, hour: 19, weather: 'cloud', intensity: 0.2, wet: 0, fog: 0.1 },
    { t_s: 30, hour: 19.5, weather: 'cloud', intensity: 0.15, wet: 0, fog: 0.12 },
  ],
};

/** E6 — Đêm: 22h, đèn bãi, đèn pha và đèn hậu xe. */
const E6: EnvPreset = {
  id: 'E6',
  name: 'Đêm',
  duration_s: 20,
  keyframes: [{ t_s: 0, hour: 22, weather: 'sun', intensity: 0.05, wet: 0, fog: 0.06 }],
};

/** E7 — Sương sớm: 5h30 → 8h, sương dày tan dần. */
const E7: EnvPreset = {
  id: 'E7',
  name: 'Sương sớm',
  duration_s: 25,
  keyframes: [
    { t_s: 0, hour: 5.5, weather: 'fog', intensity: 0.9, wet: 0.35, fog: 0.85 },
    { t_s: 10, hour: 6.5, weather: 'fog', intensity: 0.6, wet: 0.2, fog: 0.55 },
    { t_s: 20, hour: 7.5, weather: 'fog', intensity: 0.3, wet: 0.05, fog: 0.25 },
    { t_s: 25, hour: 8, weather: 'sun', intensity: 0.6, wet: 0, fog: 0.08 },
  ],
};

/** E8 — Đêm mưa: 21h, mưa vừa, mặt đường ướt phản chiếu đèn. */
const E8: EnvPreset = {
  id: 'E8',
  name: 'Đêm mưa',
  duration_s: 20,
  keyframes: [
    { t_s: 0, hour: 21, weather: 'rain', intensity: 0.55, wet: 0.95, fog: 0.15 },
    { t_s: 20, hour: 21.5, weather: 'rain', intensity: 0.6, wet: 0.95, fog: 0.18 },
  ],
};

/** Toàn bộ 8 kịch bản, đúng thứ tự E1–E8. */
export const ENV_PRESETS: readonly EnvPreset[] = [E1, E2, E3, E4, E5, E6, E7, E8];

/** Tra kịch bản theo mã; mã lạ là lỗi (R2: không trả mặc định im lặng). */
export function envPreset(id: string): EnvPreset {
  const found = ENV_PRESETS.find((preset) => preset.id === id);
  if (found === undefined) {
    throw new Error(`envPreset: không có kịch bản "${id}" (chỉ có E1–E8)`);
  }
  return found;
}

/**
 * Mốc để chụp ảnh kiểm: `t = 0` và `t = cuối`.
 *
 * Với kịch bản một mốc (E1, E3, E6) thì cả hai trùng nhau — ảnh kiểm vẫn hợp lệ.
 */
export function presetCheckpoints(preset: EnvPreset): readonly number[] {
  const last = preset.keyframes[preset.keyframes.length - 1].t_s;
  return last === 0 ? [0] : [0, last];
}

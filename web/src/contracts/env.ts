/**
 * Contract C-A — môi trường và nhiễu (ý tưởng §9, §10; FE §6; MEGAPLAN C-A).
 *
 * Thời tiết: `sun | cloud | rain | fog`. Mỗi mốc có `intensity`, riêng mưa/sương
 * thêm `wet`/`fog` để tách "trời mưa" khỏi "mặt đường còn ướt" (E4).
 */

/** Thời tiết cơ bản của một mốc. */
export const WEATHERS = ['sun', 'cloud', 'rain', 'fog'] as const;
export type Weather = (typeof WEATHERS)[number];

/** Một mốc môi trường trên dòng thời gian (FE §5, §6). */
export interface EnvKeyframe {
  /** Thời điểm trên video, giây. */
  readonly t_s: number;
  /** Giờ trong ngày, 0–24 (nén thời gian riêng, ý tưởng §9). */
  readonly hour: number;
  readonly weather: Weather;
  /** Cường độ thời tiết 0..1. */
  readonly intensity: number;
  /** Độ ướt mặt đường 0..1 (tùy chọn; mặc định suy ra từ `weather`). */
  readonly wet?: number;
  /** Độ dày sương 0..1 (tùy chọn; dùng cho `FogExp2`). */
  readonly fog?: number;
}

/** Mã 8 kịch bản môi trường dựng sẵn E1–E8 (ý tưởng §9, C10). */
export const ENV_PRESETS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'] as const;
export type EnvPresetId = (typeof ENV_PRESETS)[number];

/** Tiêu đề ngắn của từng kịch bản, dùng cho dropdown UI. */
export const ENV_PRESET_NAMES: Readonly<Record<EnvPresetId, string>> = {
  E1: 'Trưa nắng',
  E2: 'Ngày nắng',
  E3: 'Trời mây',
  E4: 'Mưa chiều',
  E5: 'Chạng vạng',
  E6: 'Đêm',
  E7: 'Sương sớm',
  E8: 'Đêm mưa',
};

/** 9 loại nhiễu camera (ý tưởng §10). Khoá cũng là tên trong `scenario.noise`. */
export const NOISE_KINDS = [
  'shake',
  'grain',
  'jpeg',
  'downscale',
  'fps_drop',
  'flare',
  'drops',
  'smudge',
  'white_balance',
] as const;
export type NoiseKind = (typeof NOISE_KINDS)[number];

/** Một nút nhiễu: bật/tắt + mức 0..1. */
export interface NoiseToggle {
  readonly on: boolean;
  /** Mức 0..1; ý nghĩa cụ thể theo loại (biên độ px, σ, chất lượng JPEG, hệ số…). */
  readonly level: number;
}

/**
 * Cấu hình nhiễu (FE §5). `seed` sinh theo frame ở `render/`, **không** ảnh hưởng GT.
 * `drops` chỉ có tác dụng khi mưa (ý tưởng §10).
 */
export interface NoiseConfig extends Readonly<Record<NoiseKind, NoiseToggle>> {
  readonly seed: number;
}

/** Cấu hình nhiễu mặc định: tất cả tắt, mức 0,5 (FE §2: mỗi nút có thanh mức). */
export function createNoiseConfig(seed: number): NoiseConfig {
  const off: NoiseToggle = { on: false, level: 0.5 };
  return {
    shake: off,
    grain: off,
    jpeg: off,
    downscale: off,
    fps_drop: off,
    flare: off,
    drops: off,
    smudge: off,
    white_balance: off,
    seed,
  };
}

/**
 * Nội suy tuyến tính giữa hai mốc tại thời điểm `t_s` (ý tưởng §9).
 * `weather` lấy mốc gần nhất phía trước; `intensity`/`wet`/`fog` nội suy.
 * Ném lỗi nếu danh sách mốc rỗng (R2).
 */
export function interpolateEnv(keyframes: readonly EnvKeyframe[], t_s: number): EnvKeyframe {
  if (keyframes.length === 0) {
    throw new Error('interpolateEnv: cần ít nhất một mốc môi trường');
  }
  const first = keyframes[0];
  if (t_s <= first.t_s) {
    return {
      ...first,
      t_s,
      wet: first.wet ?? 0,
      fog: first.fog ?? 0,
    };
  }
  for (let i = 1; i < keyframes.length; i += 1) {
    const prev = keyframes[i - 1];
    const next = keyframes[i];
    if (t_s <= next.t_s) {
      const span = next.t_s - prev.t_s;
      const k = span <= 0 ? 0 : (t_s - prev.t_s) / span;
      return {
        t_s,
        hour: prev.hour + (next.hour - prev.hour) * k,
        weather: prev.weather,
        intensity: prev.intensity + (next.intensity - prev.intensity) * k,
        wet: (prev.wet ?? 0) + ((next.wet ?? 0) - (prev.wet ?? 0)) * k,
        fog: (prev.fog ?? 0) + ((next.fog ?? 0) - (prev.fog ?? 0)) * k,
      };
    }
  }
  const last = keyframes[keyframes.length - 1];
  return { ...last, t_s, wet: last.wet ?? 0, fog: last.fog ?? 0 };
}

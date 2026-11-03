/**
 * Phần **thuần dữ liệu** của panel môi trường (P9c mục 1, FE §2).
 *
 * Không React, không DOM: nhận `EnvKeyframe[]` + thời lượng, trả vị trí trên thanh giờ,
 * mốc mặc định, và kiểm tra trước khi ghi. Nhờ vậy test bằng Node và panel chỉ còn việc vẽ.
 */

import type { EnvKeyframe, EnvPresetId, NoiseKind, NoiseToggle, Weather } from '../../contracts/env';
import { NOISE_KINDS, WEATHERS } from '../../contracts/env';
import { ENV_PRESETS, envPreset } from '../../render/env/presets';
import { sunElevationDeg, sunState, wrapHour } from '../../render/env/sun';

/** Một mốc đã đặt trên thanh giờ (vị trí tính theo %). */
export interface KeyframeMarker {
  readonly index: number;
  /** Vị trí 0–100 % trên thanh. */
  readonly percent: number;
  readonly keyframe: EnvKeyframe;
  /** Giờ dạng `HH:MM` để hiện trên nhãn. */
  readonly clock: string;
  /** Biểu tượng thời tiết (nắng/mây/mưa/sương; ban đêm có trăng). */
  readonly icon: string;
  /** Nhãn ngắn tiếng Việt. */
  readonly label: string;
}

/** Biểu tượng theo thời tiết + giờ (FE §2: "biểu tượng nắng/mây/mưa/trăng theo mốc"). */
export function weatherIcon(weather: Weather, hour: number): string {
  if (weather === 'rain') {
    return '🌧';
  }
  if (weather === 'fog') {
    return '🌫';
  }
  if (weather === 'cloud') {
    return '☁';
  }
  // `sun` mà đã lặn thì là trăng.
  return sunElevationDeg(hour) < 0 ? '🌙' : '☀';
}

/** Nhãn tiếng Việt của một mốc. */
export function weatherLabel(weather: Weather, hour: number): string {
  switch (weather) {
    case 'sun':
      return sunElevationDeg(hour) < 0 ? 'Đêm' : 'Nắng';
    case 'cloud':
      return 'Mây';
    case 'rain':
      return 'Mưa';
    case 'fog':
      return 'Sương';
    default: {
      const exhaustive: never = weather;
      throw new Error(`weatherLabel: weather lạ ${String(exhaustive)}`);
    }
  }
}

/** `7.5` thành `"07:30"`. */
export function clockLabel(hour: number): string {
  const wrapped = wrapHour(hour);
  const totalMinutes = Math.round(wrapped * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Đặt các mốc lên **thanh giờ trong ngày** (0–100 %).
 *
 * P14b lỗi 5: bản trước tính `percent` theo `t_s` (giây video), nên 6 mốc 15:00–17:30 dồn vào
 * ~0–2 % — đúng như ảnh anh An báo. Thanh có nhãn 0/6/12/18/24 h nên vị trí phải theo **giờ
 * trong ngày**: 15 h = 15/24 ≈ 62,5 % chiều ngang.
 *
 * `durationSeconds`/`t_s` không còn dùng để định vị; giữ tham số để không phá chỗ gọi cũ.
 */
export function keyframeMarkers(
  keyframes: readonly EnvKeyframe[],
  durationSeconds?: number,
): readonly KeyframeMarker[] {
  void durationSeconds;
  if (keyframes.length === 0) {
    return [];
  }
  return keyframes.map((keyframe, index) => ({
    index,
    percent: Math.min(100, Math.max(0, (wrapHour(keyframe.hour) / 24) * 100)),
    keyframe,
    clock: clockLabel(keyframe.hour),
    icon: weatherIcon(keyframe.weather, keyframe.hour),
    label: weatherLabel(keyframe.weather, keyframe.hour),
  }));
}

/** Kết quả kiểm trước khi ghi một mốc. */
export type KeyframeCheck =
  | { readonly ok: true; readonly keyframes: readonly EnvKeyframe[] }
  | { readonly ok: false; readonly reason: string };

/** Trả lý do không hợp lệ, hoặc `null` nếu hợp lệ. */
export function validateKeyframe(keyframe: EnvKeyframe): string | null {
  if (!Number.isFinite(keyframe.t_s) || keyframe.t_s < 0) {
    return `t_s phải >= 0, nhận ${String(keyframe.t_s)}`;
  }
  if (!Number.isFinite(keyframe.hour) || keyframe.hour < 0 || keyframe.hour > 24) {
    return `Giờ phải trong 0-24, nhận ${String(keyframe.hour)}`;
  }
  if (!Number.isFinite(keyframe.intensity) || keyframe.intensity < 0 || keyframe.intensity > 1) {
    return `Cường độ phải trong 0-1, nhận ${String(keyframe.intensity)}`;
  }
  for (const field of ['wet', 'fog'] as const) {
    const value = keyframe[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      return `${field} phải trong 0-1, nhận ${String(value)}`;
    }
  }
  if (!(WEATHERS as readonly string[]).includes(keyframe.weather)) {
    return `Thời tiết lạ: ${String(keyframe.weather)}`;
  }
  return null;
}

/**
 * Thêm hoặc sửa một mốc, trả danh sách **đã sắp** hoặc lý do từ chối.
 *
 * Quy tắc (contract `validateScenario` + D9 tinh thần):
 * - `hour` trong 0-24, `intensity/wet/fog` trong 0-1, `t_s >= 0`.
 * - **Ít nhất 1 mốc**: xoá mốc cuối cùng là lỗi (contract cấm `keyframes` rỗng).
 * - Không cho hai mốc cùng `t_s` (không xác định được mốc nào thắng khi nội suy).
 *
 * `index = -1` là thêm mốc; `keyframe = null` là xoá mốc `index`.
 */
export function applyKeyframeEdit(
  keyframes: readonly EnvKeyframe[],
  index: number,
  keyframe: EnvKeyframe | null,
): KeyframeCheck {
  const next = [...keyframes];

  if (keyframe === null) {
    if (index < 0 || index >= next.length) {
      return { ok: false, reason: `Không có mốc thứ ${String(index)} để xoá.` };
    }
    if (next.length === 1) {
      return {
        ok: false,
        reason: 'Phải còn ít nhất 1 mốc môi trường (contract: keyframes không được rỗng).',
      };
    }
    next.splice(index, 1);
    return { ok: true, keyframes: next };
  }

  const invalid = validateKeyframe(keyframe);
  if (invalid !== null) {
    return { ok: false, reason: invalid };
  }
  if (index === -1) {
    next.push(keyframe);
  } else if (index >= 0 && index < next.length) {
    next[index] = keyframe;
  } else {
    return { ok: false, reason: `Không có mốc thứ ${String(index)} để sửa.` };
  }
  next.sort((a, b) => a.t_s - b.t_s);
  for (let cursor = 1; cursor < next.length; cursor += 1) {
    if (next[cursor].t_s === next[cursor - 1].t_s) {
      return {
        ok: false,
        reason: `Hai mốc trùng thời điểm ${next[cursor].t_s.toFixed(2)} s - nội suy không xác định.`,
      };
    }
  }
  return { ok: true, keyframes: next };
}

/** Mốc mặc định khi người dùng bấm "thêm mốc": lấy giữa khoảng trống lớn nhất. */
export function defaultNewKeyframe(
  keyframes: readonly EnvKeyframe[],
  durationSeconds: number,
): EnvKeyframe {
  if (keyframes.length === 0) {
    return { t_s: 0, hour: 12, weather: 'sun', intensity: 0.8, wet: 0, fog: 0 };
  }
  // Tìm khoảng trống lớn nhất giữa các mốc (kể cả trước mốc đầu và sau mốc cuối).
  const sorted = [...keyframes].sort((a, b) => a.t_s - b.t_s);
  const lastT = sorted[sorted.length - 1].t_s;
  const edges = [0, ...sorted.map((keyframe) => keyframe.t_s), Math.max(durationSeconds, lastT)];
  let bestStart = edges[0];
  let bestSpan = 0;
  for (let cursor = 0; cursor < edges.length - 1; cursor += 1) {
    const span = edges[cursor + 1] - edges[cursor];
    if (span > bestSpan) {
      bestSpan = span;
      bestStart = edges[cursor];
    }
  }
  const t_s = bestSpan <= 0 ? lastT : bestStart + bestSpan / 2;
  // Thừa hưởng giờ + thời tiết từ mốc gần nhất phía trước để mốc mới liền mạch.
  const previous = [...sorted].reverse().find((keyframe) => keyframe.t_s <= t_s) ?? sorted[0];
  return {
    t_s,
    hour: previous.hour,
    weather: previous.weather,
    intensity: previous.intensity,
    wet: previous.wet ?? 0,
    fog: previous.fog ?? 0,
  };
}

/** Một nút nhiễu trong panel: khoá contract + nhãn + mô tả mức. */
export interface NoiseControl {
  readonly kind: NoiseKind;
  readonly label: string;
  /** Mô tả mức thấp đến cao (để người dùng hiểu thanh mức). */
  readonly scale: string;
}

/** 9 nút nhiễu đúng ý tưởng §10, nhãn tiếng Việt. */
export const NOISE_CONTROLS: readonly NoiseControl[] = [
  { kind: 'shake', label: 'Rung', scale: 'biên độ 0-6 px' },
  { kind: 'grain', label: 'Hạt nhiễu', scale: 'sigma 0-18' },
  { kind: 'jpeg', label: 'Nén JPEG', scale: 'chất lượng 95 xuống 20' },
  { kind: 'downscale', label: 'Giảm phân giải', scale: 'hệ số 1,0 xuống 0,1' },
  { kind: 'fps_drop', label: 'Giảm fps', scale: 'giữ 1/2 đến 3/4 frame' },
  { kind: 'flare', label: 'Lóa ống kính', scale: 'theo vị trí mặt trời' },
  { kind: 'drops', label: 'Giọt nước', scale: '6-40 giọt (chỉ khi mưa)' },
  { kind: 'smudge', label: 'Vệt bẩn / che góc', scale: 'bán kính 35-80 %' },
  { kind: 'white_balance', label: 'Lệch cân bằng trắng', scale: 'ấm/lạnh 0-34' },
];

/** Kiểm `NOISE_CONTROLS` phủ đúng 9 khoá contract (test dùng). */
export function noiseControlsCoverContract(): boolean {
  const fromControls = NOISE_CONTROLS.map((control) => control.kind).sort();
  const fromContract = [...NOISE_KINDS].sort();
  return (
    fromControls.length === fromContract.length &&
    fromControls.every((kind, index) => kind === fromContract[index])
  );
}

/** 8 preset cho dropdown, lấy từ `render/env/presets` để không lặp dữ liệu. */
export const PRESET_OPTIONS: readonly { readonly id: EnvPresetId; readonly name: string }[] =
  ENV_PRESETS.map((preset) => ({ id: preset.id, name: preset.name }));

/** Lấy preset theo mã, ném lỗi nếu lạ (R2 - không trả mặc định). */
export function presetById(id: string): (typeof ENV_PRESETS)[number] {
  return envPreset(id);
}

/** Tóm tắt thanh giờ: giờ nhỏ nhất đến lớn nhất + số mốc. */
export function timelineSummary(keyframes: readonly EnvKeyframe[]): string {
  if (keyframes.length === 0) {
    return '—';
  }
  const sorted = [...keyframes].sort((a, b) => a.t_s - b.t_s);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1) {
    return `${clockLabel(first.hour)} · ${weatherLabel(first.weather, first.hour)}`;
  }
  return `${clockLabel(first.hour)} → ${clockLabel(last.hour)} · ${String(sorted.length)} mốc`;
}

/** Trạng thái mặt trời tại mốc đang chọn (hiện trên thanh giờ). */
export function sunSummary(keyframe: EnvKeyframe): {
  readonly clock: string;
  readonly icon: string;
  readonly label: string;
  readonly elevationDeg: number;
  readonly lampsOn: boolean;
} {
  const sun = sunState(keyframe.hour, keyframe.weather === 'rain' ? keyframe.intensity : 0);
  return {
    clock: clockLabel(keyframe.hour),
    icon: weatherIcon(keyframe.weather, keyframe.hour),
    label: weatherLabel(keyframe.weather, keyframe.hour),
    elevationDeg: sun.elevationDeg,
    lampsOn: sun.lampsOn,
  };
}

/** Toggle nhiễu mới, giữ nguyên mức cũ khi bật lại. */
export function toggleNoise(current: NoiseToggle, on: boolean): NoiseToggle {
  return { on, level: current.level };
}

/** Đổi mức nhiễu, kẹp 0-1 và giữ nguyên trạng thái bật/tắt. */
export function setNoiseLevel(current: NoiseToggle, level: number): NoiseToggle {
  return { on: current.on, level: Math.min(1, Math.max(0, level)) };
}

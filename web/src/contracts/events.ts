/**
 * Contract C-A — sự kiện và nhật ký (FE §4.5, U15, C1, D9).
 *
 * Nhật ký là nguồn sự thật để chạy lại: mỗi sự kiện ghi `frame` mô phỏng lúc bấm,
 * `params`, và `resolved` chứa kết quả đã bốc ngẫu nhiên (ô, mẫu, màu, car_id) để
 * chạy lại không phụ thuộc thứ tự RNG.
 */

import type { CarColor, CarModel } from './sim';
import type { SlotId } from './lot';

/** 7 loại sự kiện (FE §4.5). */
export const EVENT_TYPES = [
  'add_car',
  'add_cars',
  'leave',
  'leave_random',
  'set_speed',
  'env_keyframe',
  'noise',
] as const;
export type SimEventType = (typeof EVENT_TYPES)[number];

/** Ô đích của `add_car`: chỉ định hoặc bốc ngẫu nhiên ô trống. */
export type SlotTarget = SlotId | 'random_free';

/** Tham số `add_car` (FE §4.5). */
export interface AddCarParams {
  /** Ô đích; `random_free` = bốc ô trống ngay lúc áp sự kiện. */
  readonly slot: SlotTarget;
  /** Tốc độ mong muốn, km/h. */
  readonly speed_kmh: number;
  /** Mẫu xe; bỏ trống = bốc theo luồng RNG `model`. */
  readonly model?: CarModel;
  /** Màu; bỏ trống = bốc theo luồng RNG `color`. */
  readonly color?: CarColor;
  /** Thời gian đỗ, giây; bỏ trống = đỗ tới khi có lệnh rời. */
  readonly park_s?: number;
}

/** Tham số `add_cars` (FE §4.5): N xe vào hàng chờ, ô bốc ngẫu nhiên không trùng. */
export interface AddCarsParams {
  readonly n: number;
  /** Khoảng cách giữa các xe trong hàng chờ, giây (mặc định 2). */
  readonly gap_s: number;
  /** Tốc độ mong muốn, km/h. */
  readonly speed_kmh: number;
}

/** Tham số `leave`. */
export interface LeaveParams {
  readonly car_id: string;
}

/** Tham số `leave_random`. */
export interface LeaveRandomParams {
  readonly n: number;
}

/** Tham số `set_speed`. */
export interface SetSpeedParams {
  readonly car_id: string;
  readonly speed_kmh: number;
}

/** Tham số `env_keyframe` — thêm/sửa mốc môi trường trên thanh giờ. */
export interface EnvKeyframeParams {
  readonly keyframe: {
    readonly t_s: number;
    readonly hour: number;
    readonly weather: 'sun' | 'cloud' | 'rain' | 'fog';
    readonly intensity: number;
    readonly wet?: number;
    readonly fog?: number;
  };
  /** `add` = thêm mốc, `update` = sửa mốc trùng `t_s`. */
  readonly op: 'add' | 'update';
}

/** Tham số `noise` — bật/tắt một nút nhiễu, hoặc đổi seed. */
export interface NoiseParams {
  readonly kind: 'shake' | 'grain' | 'jpeg' | 'downscale' | 'fps_drop' | 'flare' | 'drops' | 'smudge' | 'white_balance';
  readonly on: boolean;
  readonly level: number;
  /** Chỉ dùng khi đổi seed nhiễu. */
  readonly seed?: number;
}

export type SimEventParams =
  | AddCarParams
  | AddCarsParams
  | LeaveParams
  | LeaveRandomParams
  | SetSpeedParams
  | EnvKeyframeParams
  | NoiseParams;

/** Kết quả đã bốc của một sự kiện, ghi vào nhật ký để chạy lại y hệt. */
export interface ResolvedEvent {
  /** Xe được tạo/bị ảnh hưởng. */
  readonly car_ids?: readonly string[];
  readonly slots?: readonly SlotId[];
  readonly models?: readonly CarModel[];
  readonly colors?: readonly CarColor[];
}

/** Một sự kiện trong nhật ký (FE §4.5, §5). */
export interface SimEvent {
  /** Frame mô phỏng lúc bấm. */
  readonly frame: number;
  readonly type: SimEventType;
  readonly params: SimEventParams;
  /** Kết quả đã bốc; có mặt khi sự kiện dùng RNG. */
  readonly resolved?: ResolvedEvent;
}

/** Sự kiện bị từ chối (ô đã có xe, mã xe không tồn tại…) — vẫn phải báo, không nuốt (R2). */
export interface RejectedEvent {
  readonly frame: number;
  readonly event: SimEvent;
  readonly reason: string;
}

/** Kiểm tra "sự kiện mới chỉ được thêm khi frame hiện tại ≥ frame sự kiện cuối" (D9). */
export function canAppendEvent(log: readonly SimEvent[], currentFrame: number): boolean {
  if (log.length === 0) {
    return true;
  }
  const last = log[log.length - 1];
  return currentFrame >= last.frame;
}

/** Ném lỗi nếu vi phạm D9 — không im lặng chèn sự kiện vào giữa. */
export function assertAppendableEvent(log: readonly SimEvent[], event: SimEvent): void {
  if (event.frame < 0) {
    throw new Error(`Sự kiện ở frame âm: ${event.frame}`);
  }
  if (!canAppendEvent(log, event.frame)) {
    const last = log[log.length - 1];
    throw new Error(
      `Sự kiện frame ${event.frame} chen trước sự kiện cuối (frame ${last.frame}) — D9 cấm tua lùi`,
    );
  }
}

/** Sự kiện này có bốc ngẫu nhiên không (để biết cần ghi `resolved`). */
export function drawsRandom(event: SimEvent): boolean {
  switch (event.type) {
    case 'add_car':
      return true;
    case 'add_cars':
      return true;
    case 'leave_random':
      return true;
    case 'leave':
    case 'set_speed':
    case 'env_keyframe':
    case 'noise':
      return false;
    default: {
      const exhaustive: never = event.type;
      throw new Error(`Loại sự kiện lạ: ${String(exhaustive)}`);
    }
  }
}

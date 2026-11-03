/**
 * Contract C-A — kịch bản `.sim3d.json` (FE §5, U12; D4, D9).
 *
 * Đây là **định dạng lưu trên đĩa**. BE kiểm `schema === 1` + các trường bắt buộc khi
 * PUT (`/api/scenarios/<name>`, BE §3); FE dùng cùng hàm `validateScenario` để báo lỗi
 * trước khi gửi. Sai thì ném/ném lỗi trả về — không im lặng sửa dữ liệu người dùng.
 */

import type { EnvKeyframe, NoiseConfig, NoiseKind } from './env';
import { NOISE_KINDS, createNoiseConfig } from './env';
import type { ResolvedEvent, SimEvent, SimEventParams } from './events';
import type { CarColor, CarModel } from './sim';
import { CAR_COLORS, CAR_MODELS, CAR_SCALE_DEFAULT, CAR_SCALE_MAX, CAR_SCALE_MIN } from './sim';
import type { SlotId } from './lot';
import { assertSlotId } from './lot';

/** Phiên bản schema hiện hành. BE từ chối mọi giá trị khác. */
export const SCENARIO_SCHEMA = 1;

/** Chế độ camera (U2, U19). */
export const CAMERA_MODES = ['1cam', '2cam'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

/** Một xe đỗ sẵn đã bốc xong ở frame 0 (FE §5 `initial.placement`). */
export interface InitialPlacement {
  readonly slot: SlotId;
  readonly car_id: string;
  readonly model: CarModel;
  readonly color: CarColor;
  /** Hệ số tỉ lệ thực sau khi chặn theo ô (D4). */
  readonly scale?: number;
}

/** Xe đỗ sẵn lúc tạo map (U4, FE §5). */
export interface InitialFleet {
  /** Số xe đỗ sẵn, 0–100. */
  readonly n_parked: number;
  /** Danh sách đã bốc sẵn — chạy lại không phụ thuộc RNG. */
  readonly placement: readonly InitialPlacement[];
}

/** Môi trường của kịch bản (FE §5, ý tưởng §9). */
export interface ScenarioEnv {
  /** Kịch bản dựng sẵn E1–E8, hoặc `null` khi người dùng tự đặt mốc. */
  readonly preset: string | null;
  readonly keyframes: readonly EnvKeyframe[];
}

/** Toàn bộ file `*.sim3d.json`. */
export interface Scenario {
  readonly schema: typeof SCENARIO_SCHEMA;
  /** Tên bãi; hiện chỉ "pucpr" (ý tưởng §4). */
  readonly lot: string;
  /** Seed gốc của mọi luồng RNG (C3). */
  readonly seed: number;
  /** Tỉ lệ xe người dùng chọn, 1,00–1,30 (C5). */
  readonly car_scale: number;
  /** Tốc độ mặc định, km/h (FE §2: 5–20). */
  readonly default_speed_kmh: number;
  readonly camera_mode: CameraMode;
  readonly initial: InitialFleet;
  readonly env: ScenarioEnv;
  readonly noise: NoiseConfig;
  /** Nhật ký sự kiện live, tăng dần theo frame (D9). */
  readonly events: readonly SimEvent[];
  /** Frame cuối khi người dùng dừng; sửa được (FE §5). */
  readonly duration_frames: number;
}

/** Lỗi dữ liệu kịch bản; `path` chỉ đúng trường sai để UI/BE báo chính xác. */
export class ScenarioValidationError extends Error {
  override readonly name = 'ScenarioValidationError';

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

function fail(path: string, message: string): never {
  throw new ScenarioValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(path, 'phải là object');
  }
  return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `phải là số nguyên trong [${min}, ${max}]`);
  }
  return value;
}

function requireNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `phải là số trong [${min}, ${max}]`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'phải là chuỗi không rỗng');
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `phải là một trong: ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(path, 'phải là mảng');
  }
  return value;
}

const EVENT_TYPE_ALLOWED = [
  'add_car',
  'add_cars',
  'leave',
  'leave_random',
  'set_speed',
  'env_keyframe',
  'noise',
] as const;

/**
 * Kiểm một object bất kỳ có phải `Scenario` schema 1 hợp lệ.
 * Trả object đã chuẩn hoá (giữ nguyên giá trị), ném `ScenarioValidationError` nếu sai.
 */
export function validateScenario(raw: unknown): Scenario {
  const root = requireRecord(raw, '$');

  if (root.schema !== SCENARIO_SCHEMA) {
    fail('schema', `phải bằng ${SCENARIO_SCHEMA}`);
  }
  const lot = requireString(root.lot, 'lot');
  const seed = requireInteger(root.seed, 'seed', 0, 0xffffffff);
  const carScale = requireNumber(root.car_scale, 'car_scale', 1.0, 1.3);
  const speed = requireNumber(root.default_speed_kmh, 'default_speed_kmh', 5, 20);
  const cameraMode = requireEnum(root.camera_mode, 'camera_mode', CAMERA_MODES);
  const durationFrames = requireInteger(root.duration_frames, 'duration_frames', 0, 2_000_000);

  const initial = requireRecord(root.initial, 'initial');
  const nParked = requireInteger(initial.n_parked, 'initial.n_parked', 0, 100);
  const placementRaw = requireArray(initial.placement, 'initial.placement');
  if (placementRaw.length !== nParked) {
    fail('initial.placement', `có ${placementRaw.length} phần tử nhưng n_parked = ${nParked}`);
  }
  const seenSlots = new Set<string>();
  const seenCars = new Set<string>();
  const placement = placementRaw.map((item, index): InitialPlacement => {
    const at = `initial.placement[${index}]`;
    const entry = requireRecord(item, at);
    const slot = assertSlotId(requireString(entry.slot, `${at}.slot`));
    const carId = requireString(entry.car_id, `${at}.car_id`);
    const model = requireEnum(entry.model, `${at}.model`, CAR_MODELS);
    const color = requireEnum(entry.color, `${at}.color`, CAR_COLORS);
    if (seenSlots.has(slot)) {
      fail(`${at}.slot`, `ô "${slot}" bị xếp hai xe`);
    }
    seenSlots.add(slot);
    if (seenCars.has(carId)) {
      fail(`${at}.car_id`, `mã xe "${carId}" bị trùng`);
    }
    seenCars.add(carId);
    const scale =
      entry.scale === undefined
        ? undefined
        : requireNumber(entry.scale, `${at}.scale`, CAR_SCALE_MIN, CAR_SCALE_MAX);
    return scale === undefined
      ? { slot, car_id: carId, model, color }
      : { slot, car_id: carId, model, color, scale };
  });

  const env = requireRecord(root.env, 'env');
  const preset = env.preset === null ? null : requireString(env.preset, 'env.preset');
  const keyframesRaw = requireArray(env.keyframes, 'env.keyframes');
  const keyframes = keyframesRaw.map((item, index) => {
    const at = `env.keyframes[${index}]`;
    const kf = requireRecord(item, at);
    const tS = requireNumber(kf.t_s, `${at}.t_s`, 0, 1e6);
    const hour = requireNumber(kf.hour, `${at}.hour`, 0, 24);
    const weather = requireEnum(kf.weather, `${at}.weather`, ['sun', 'cloud', 'rain', 'fog'] as const);
    const intensity = requireNumber(kf.intensity, `${at}.intensity`, 0, 1);
    const wet = kf.wet === undefined ? undefined : requireNumber(kf.wet, `${at}.wet`, 0, 1);
    const fog = kf.fog === undefined ? undefined : requireNumber(kf.fog, `${at}.fog`, 0, 1);
    return {
      t_s: tS,
      hour,
      weather,
      intensity,
      ...(wet === undefined ? {} : { wet }),
      ...(fog === undefined ? {} : { fog }),
    };
  });
  if (keyframes.length === 0) {
    fail('env.keyframes', 'phải có ít nhất một mốc');
  }

  const noiseRaw = requireRecord(root.noise, 'noise');
  const noiseSeed = requireInteger(noiseRaw.seed, 'noise.seed', 0, 0xffffffff);
  const toggles = {} as Record<NoiseKind, { on: boolean; level: number }>;
  for (const kind of NOISE_KINDS) {
    const toggleRaw = requireRecord(noiseRaw[kind], `noise.${kind}`);
    if (typeof toggleRaw.on !== 'boolean') {
      fail(`noise.${kind}.on`, 'phải là boolean');
    }
    toggles[kind] = {
      on: toggleRaw.on,
      level: requireNumber(toggleRaw.level, `noise.${kind}.level`, 0, 1),
    };
  }
  const noise: NoiseConfig = { ...toggles, seed: noiseSeed };

  const eventsRaw = requireArray(root.events, 'events');
  let lastFrame = -1;
  const events = eventsRaw.map((item, index) => {
    const at = `events[${index}]`;
    const event = requireRecord(item, at);
    const frame = requireInteger(event.frame, `${at}.frame`, 0, durationFrames);
    if (frame < lastFrame) {
      fail(`${at}.frame`, `phải tăng dần (D9 cấm tua lùi), gặp ${frame} sau ${lastFrame}`);
    }
    lastFrame = frame;
    const type = requireEnum(event.type, `${at}.type`, EVENT_TYPE_ALLOWED);
    const params = requireRecord(event.params, `${at}.params`);
    const typed: SimEvent = {
      frame,
      type,
      params: params as unknown as SimEventParams,
      ...(event.resolved === undefined
        ? {}
        : { resolved: event.resolved as unknown as ResolvedEvent }),
    };
    return typed;
  });

  return {
    schema: SCENARIO_SCHEMA,
    lot,
    seed,
    car_scale: carScale,
    default_speed_kmh: speed,
    camera_mode: cameraMode,
    initial: { n_parked: nParked, placement },
    env: { preset, keyframes },
    noise,
    events,
    duration_frames: durationFrames,
  };
}

/** Kịch bản mặc định mở lúc khởi động (chưa có gì chạy). */
export function createDefaultScenario(seed = 1): Scenario {
  return {
    schema: SCENARIO_SCHEMA,
    lot: 'pucpr',
    seed,
    car_scale: CAR_SCALE_DEFAULT,
    default_speed_kmh: 10,
    camera_mode: '1cam',
    initial: { n_parked: 0, placement: [] },
    env: {
      preset: 'E1',
      keyframes: [{ t_s: 0, hour: 12, weather: 'sun', intensity: 0.8 }],
    },
    noise: createNoiseConfig(seed),
    events: [],
    duration_frames: 500,
  };
}

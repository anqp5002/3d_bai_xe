/**
 * Mô hình dữ liệu cho UI P9 (FE §2, §4.5, §5; D9).
 *
 * File này **thuần dữ liệu**: chỉ import contract + `sim/` + phần data của `render/`
 * (`placement.ts`), không three, không React, không DOM. Nhờ vậy store và test chạy
 * bằng Node, còn việc vẽ nằm ở `ui/`.
 */

import type { CarColor, CarModel, SimState, Warning } from '../contracts/sim';
import type { LotMap, SlotId } from '../contracts/lot';
import type { CameraMode, Scenario } from '../contracts/scenario';
import { SCENARIO_SCHEMA } from '../contracts/scenario';
import { createNoiseConfig } from '../contracts/env';
import type { AddCarParams, SimEvent } from '../contracts/events';
import { assertAppendableEvent, canAppendEvent } from '../contracts/events';
import { createState, isHalted, step } from '../sim';
import {
  maxCarWidthInSlot,
  modelWidthM,
  placeParkedCars,
} from '../render/placement';
import type { CameraCount, CameraViewMode } from '../render/cameraGeometry';

/** Thời lượng mặc định của map mới, frame (120 s ở 25 fps). */
export const DEFAULT_DURATION_FRAMES = 3000;
/** FPS cố định của sim (U19). */
export const SIM_FPS = 25;

/** Tham số panel map/xe (FE §2). */
export interface MapSettings {
  readonly seed: number;
  /** Hệ số người dùng chọn 1,00–1,30 (C5); D4 chặn tiếp theo từng ô. */
  readonly carScale: number;
  /** Số xe đỗ sẵn 0–100 (U4). */
  readonly nParked: number;
  /** Tốc độ mặc định, km/h (FE §2: 5–20). */
  readonly defaultSpeedKmh: number;
  readonly cameraMode: CameraMode;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  seed: 1,
  carScale: 1.1,
  nParked: 30,
  defaultSpeedKmh: 10,
  cameraMode: '2cam',
};

/** Mẫu/màu dùng cho nút “Thêm xe” (FE §4.5 `add_car`). */
export const DEFAULT_SPAWN_MODEL: CarModel = 'sedan';
export const DEFAULT_SPAWN_COLOR: CarColor = 'red';

/** Kết quả dựng kịch bản từ panel map. */
export interface BuiltScenario {
  readonly scenario: Scenario;
  /** Cảnh báo D4/dữ liệu để hiện ngay dưới panel (rỗng = không có gì). */
  readonly warnings: readonly string[];
}

function requireInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} phải là số nguyên trong [${String(min)}, ${String(max)}]`);
  }
  return value;
}

function requireNumber(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} phải là số trong [${String(min)}, ${String(max)}]`);
  }
  return value;
}

/** Bề rộng ô gốc (không phụ thuộc model) dùng cho cảnh báo D4. */
function slotById(lot: LotMap, slotId: SlotId) {
  const slot = lot.slots.find((candidate) => candidate.id === slotId);
  if (slot === undefined) {
    throw new Error(`Ô "${slotId}" không có trong bãi "${lot.name}"`);
  }
  return slot;
}

/**
 * Dựng `Scenario` (FE §5) từ panel map, dùng đúng `placeParkedCars` của render/placement
 * để cùng seed cho cùng xe (và cùng D4).
 */
export function buildScenario(
  lot: LotMap,
  settings: MapSettings,
  durationFrames: number = DEFAULT_DURATION_FRAMES,
): BuiltScenario {
  const seed = requireInteger(settings.seed, 'seed', 0, 0xffffffff);
  const carScale = requireNumber(settings.carScale, 'car_scale', 1, 1.3);
  const nParked = requireInteger(settings.nParked, 'n_parked', 0, 100);
  const speed = requireNumber(settings.defaultSpeedKmh, 'default_speed_kmh', 5, 20);
  const duration = requireInteger(durationFrames, 'duration_frames', 1, 2_000_000);

  const cars = placeParkedCars(lot.slots, nParked, seed, carScale);
  const warnings: string[] = [];
  let clamped = 0;
  let unfit = 0;
  for (const car of cars) {
    const slot = slotById(lot, car.slot);
    if (car.scale < carScale - 1e-9) {
      clamped += 1;
    }
    if (modelWidthM(car.model) > maxCarWidthInSlot(slot.width_m) + 1e-9) {
      unfit += 1;
    }
  }
  if (clamped > 0) {
    warnings.push(`D4: ${String(clamped)}/${String(cars.length)} xe bị hạ tỉ lệ cho vừa ô.`);
  }
  if (unfit > 0) {
    warnings.push(`D4: ${String(unfit)} xe không vừa ô (ô quá hẹp).`);
  }

  const scenario: Scenario = {
    schema: SCENARIO_SCHEMA,
    lot: lot.name,
    seed,
    car_scale: carScale,
    default_speed_kmh: speed,
    camera_mode: settings.cameraMode,
    initial: {
      n_parked: cars.length,
      placement: cars.map((car) => ({
        slot: car.slot,
        car_id: car.car_id,
        model: car.model,
        color: car.color,
        scale: car.scale,
      })),
    },
    env: {
      preset: 'E1',
      keyframes: [{ t_s: 0, hour: 12, weather: 'sun', intensity: 0.8 }],
    },
    noise: createNoiseConfig(seed),
    events: [],
    duration_frames: duration,
  };
  return { scenario, warnings };
}

/** Gom sự kiện theo frame để mỗi bước chỉ tra một lần (D9: đã sắp tăng dần). */
export function groupEventsByFrame(
  log: readonly SimEvent[],
): ReadonlyMap<number, readonly SimEvent[]> {
  const grouped = new Map<number, SimEvent[]>();
  for (const event of log) {
    const list = grouped.get(event.frame);
    if (list === undefined) {
      grouped.set(event.frame, [event]);
    } else {
      list.push(event);
    }
  }
  return grouped;
}

/** Thêm sự kiện vào nhật ký, kiểm D9 (không chèn trước sự kiện cuối). */
export function appendEventLog(
  log: readonly SimEvent[],
  event: SimEvent,
): readonly SimEvent[] {
  assertAppendableEvent(log, event);
  return [...log, event];
}

/** Có được thêm sự kiện ở `frame` không (D9). */
export function canAddEventAt(log: readonly SimEvent[], frame: number): boolean {
  return canAppendEvent(log, frame);
}

/** Sự kiện `add_car` với mọi trường đã chỉ định (không cần `resolved`). */
export function addCarEvent(
  frame: number,
  slot: SlotId,
  speedKmh: number,
  model: CarModel,
  color: CarColor,
): SimEvent {
  return {
    frame,
    type: 'add_car',
    params: { slot, speed_kmh: speedKmh, model, color },
  };
}

/** Sự kiện `leave`. */
export function leaveEvent(frame: number, carId: string): SimEvent {
  return { frame, type: 'leave', params: { car_id: carId } };
}

/** Sự kiện `set_speed`. */
export function setSpeedEvent(frame: number, carId: string, speedKmh: number): SimEvent {
  return { frame, type: 'set_speed', params: { car_id: carId, speed_kmh: speedKmh } };
}

/** Kết quả chạy `count` bước liên tiếp. */
export interface SimAdvance {
  readonly state: SimState;
  /** Các frame mới, đúng thứ tự (không gồm state đầu vào). */
  readonly history: readonly SimState[];
}

/**
 * Chạy `count` bước cố định từ `state`, áp sự kiện đúng frame (FE §4.1, D9).
 * Dừng khi chạm `durationFrames` (frame cuối = duration−1).
 */
export function advanceSim(
  lot: LotMap,
  state: SimState,
  log: readonly SimEvent[],
  count: number,
  durationFrames: number,
): SimAdvance {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`advanceSim: count phải là số nguyên ≥ 0, nhận ${String(count)}`);
  }
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new Error(
      `advanceSim: durationFrames phải là số nguyên > 0, nhận ${String(durationFrames)}`,
    );
  }
  const grouped = groupEventsByFrame(log);
  let current = state;
  const history: SimState[] = [];
  for (let index = 0; index < count; index += 1) {
    if (current.frame >= durationFrames) {
      break;
    }
    current = step(lot, current, {
      frame: current.frame,
      events: grouped.get(current.frame) ?? [],
    });
    history.push(current);
    if (isHalted(current)) {
      // FE §4.4.4: va chạm thì tạm dừng mô phỏng, không chạy tiếp trong im lặng.
      break;
    }
  }
  return { state: current, history };
}

/** Tạo state frame 0 từ kịch bản. */
export function startSim(lot: LotMap, scenario: Scenario): SimState {
  if (scenario.lot !== lot.name) {
    throw new Error(
      `Kịch bản thuộc bãi "${scenario.lot}" nhưng đang mở bãi "${lot.name}"`,
    );
  }
  return createState(lot, scenario);
}

/** Ô còn trống ở state hiện tại (chỉ ô `reachable`). */
export function freeSlotIds(lot: LotMap, state: SimState): readonly SlotId[] {
  const used = new Set<SlotId>();
  for (const car of state.cars) {
    if (car.state !== 'exited' && car.slot !== null) {
      used.add(car.slot);
    }
  }
  return lot.slots
    .filter((slot) => slot.reachable && !used.has(slot.id))
    .map((slot) => slot.id);
}

/**
 * Như `freeSlotIds`, nhưng **trừ cả ô đã bị sự kiện `add_car` trong tương lai chiếm**.
 *
 * Vì sao cần (P14a, lỗi 4 anh An báo "thêm 2 xe là hết"): `freeSlotIds` chỉ nhìn `state.cars`
 * của **frame hiện tại**. Nếu người dùng thêm 10 xe ở các frame tương lai thì lúc bấm lần 2,
 * frame hiện tại **chưa** có xe nào ⇒ hàm cũ vẫn trả về ô đầu tiên ⇒ hai sự kiện `add_car`
 * cùng một ô, và lần thêm thứ hai bị engine từ chối.
 *
 * `pending` = các sự kiện `add_car` **chưa được mô phỏng**, tức `frame >= currentFrame`.
 *
 * Dùng `>=` chứ không phải `>`: khi sim đang dừng ở frame N và người dùng thêm xe ở frame N
 * thì sự kiện đó **chưa** chạy (engine chỉ đọc `eventsAtFrame` khi bước sang frame đó), nên ô vẫn
 * phải bị giữ. Nếu chỉ dùng `>` thì bấm "Thêm" lần 2 sẽ lại chọn ô vừa chiếm — đúng lỗi 4.
 */
export function freeSlotIdsWithPending(
  lot: LotMap,
  state: SimState,
  pending: readonly SimEvent[],
): readonly SlotId[] {
  const base = freeSlotIds(lot, state);
  const reserved = new Set<SlotId>();
  for (const event of pending) {
    if (event.type !== 'add_car') {
      // `add_cars` bốc ô lúc chạy (engine quyết) ⇒ không biết trước ô nào; bỏ qua an toàn hơn
      // là đoán, và form P14a không sinh loại này.
      continue;
    }
    // `SimEvent` chưa phải union phân biệt theo `type` ⇒ ép kiểu có kiểm tra tường minh.
    const params = event.params as AddCarParams;
    // `slot` có thể là `'random_free'` (bốc ô lúc chạy) ⇒ chỉ giữ khi là mã ô cụ thể.
    if (typeof params.slot !== 'string' || params.slot === 'random_free') {
      continue;
    }
    reserved.add(params.slot);
  }
  return base.filter((slot) => !reserved.has(slot));
}

/** Cảnh báo của frame hiện tại theo loại (để UI tô màu). */
export function warningsOf(state: SimState, kind: Warning['kind']): readonly Warning[] {
  return state.warnings.filter((warning) => warning.kind === kind);
}

/** Có đang dừng vì va chạm không (FE §4.4.4). */
export function halted(state: SimState): boolean {
  return isHalted(state);
}

/** `mm:ss` của frame ở 25 fps. */
export function frameTimecode(frame: number, fps: number = SIM_FPS): string {
  const safe = Math.max(0, Math.floor(frame));
  const totalSeconds = Math.floor(safe / fps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Nhãn timeline: `mm:ss · frame N`. */
export function frameLabel(frame: number, fps: number = SIM_FPS): string {
  return `${frameTimecode(frame, fps)} · frame ${String(Math.max(0, Math.floor(frame)))}`;
}

/** Đổi frame sang giây (hiện trong panel map/xuất). */
export function frameSeconds(frame: number, fps: number = SIM_FPS): number {
  return Math.max(0, frame) / fps;
}

/** Nhãn trạng thái xe tiếng Việt (FE §4.2). */
export const CAR_STATE_LABEL: Readonly<Record<string, string>> = {
  queued: 'chờ cổng',
  entering: 'vào cổng',
  driving_to_slot: 'tới ô',
  parking_in: 'đang vào ô',
  parked: 'đỗ',
  leaving_slot: 'đang ra',
  driving_to_exit: 'ra cổng',
  exited: 'đã ra',
};

/** Nhãn chế độ xem (FE §2). */
export const VIEW_MODE_LABEL: Readonly<Record<CameraViewMode, string>> = {
  dataset: 'Camera dataset',
  free: 'Tự do',
  record: 'Quay',
};

/** Nhãn 1 cam / 2 cam. */
export const CAMERA_COUNT_LABEL: Readonly<Record<CameraCount, string>> = {
  '1cam': '1 cam',
  '2cam': '2 cam',
};

/** Ghi chú ANS_1 A.1 khi chọn 1 cam. */
export const ONE_CAM_NOTE = '1 cam: chỉ để xem/quay, TechGAR cần 2 cam';

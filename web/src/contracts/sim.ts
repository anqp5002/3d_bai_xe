/**
 * Contract C-A — trạng thái mô phỏng (FE §4.1–§4.4, D7, D8, C4, C5).
 *
 * Quy ước bắt buộc:
 * - `dt = 0,04 s` cố định, `frame` là số nguyên (25 fps, U19).
 * - Trạng thái là **dữ liệu thuần**: không three, không react, không DOM (R3).
 * - `step` thuần: trả state mới, không sửa state vào.
 * - Không `Math.random`, không `Date.now`, không `performance.now` (R3, C3).
 */

import type { EnvKeyframe } from './env';
import type { LotMap, SlotId, Vec2 } from './lot';
import type { CameraMode, Scenario } from './scenario';
import type { GtEventRow, GtFrameRow } from './gt';
import type { SimEvent } from './events';
import { DT_S, FPS } from '../sim/constants';
import { createSimState, advanceSimState } from '../sim/engine';
import { gtEvents as computeGtEvents, gtRow as computeGtRow } from '../sim/gtCompute';
import { SimError } from '../sim/errors';

export { DT_S, FPS };
export { SimError };
/** Số bước mỗi giây mô phỏng. */
export const STEPS_PER_SECOND = 1 / DT_S;

/** 3 mẫu xe (C4, C-C). */
export const CAR_MODELS = ['sedan', 'suv', 'hatch'] as const;
export type CarModel = (typeof CAR_MODELS)[number];

/** Kích thước gốc khi hệ số tỉ lệ = 1,00 (C4), mét: [dài, rộng, cao]. */
export const CAR_DIMENSIONS_M: Readonly<Record<CarModel, readonly [number, number, number]>> = {
  sedan: [4.6, 1.8, 1.45],
  suv: [4.7, 1.9, 1.7],
  hatch: [4.0, 1.75, 1.5],
};

/** Bảng 8 màu (C4): trắng, đen, bạc, xám, đỏ, xanh dương, xanh lá đậm, vàng cát. */
export const CAR_COLORS = [
  'white',
  'black',
  'silver',
  'gray',
  'red',
  'blue',
  'green',
  'sand',
] as const;
export type CarColor = (typeof CAR_COLORS)[number];

/** Màu hex dùng cho material `paint` (C-C) và cho chú giải trên UI. */
export const CAR_COLOR_HEX: Readonly<Record<CarColor, string>> = {
  white: '#f2f2f0',
  black: '#1b1b1d',
  silver: '#c8ccd0',
  gray: '#6f7377',
  red: '#b42318',
  blue: '#1f4fb8',
  green: '#1d5c33',
  sand: '#c9b083',
};

/** Hệ số tỉ lệ xe (C5): mặc định 1,10; cho phép 1,00–1,30; còn bị chặn theo ô (D4). */
export const CAR_SCALE_DEFAULT = 1.1;
export const CAR_SCALE_MIN = 1.0;
export const CAR_SCALE_MAX = 1.3;

/** Chặn theo ô (D4): hệ số thực = min(hệ số chọn, (w_ô − 0,35) / w_xe). */
export const SLOT_EDGE_MARGIN_M = 0.35;
/** Ô hẹp hơn ngưỡng này chỉ nhận hatchback (D4). */
export const NARROW_SLOT_WIDTH_M = 2.1;

/** Vòng đời xe (FE §4.2). */
export const CAR_STATES = [
  'queued',
  'entering',
  'driving_to_slot',
  'parking_in',
  'parked',
  'leaving_slot',
  'driving_to_exit',
  'exited',
] as const;
export type CarStateName = (typeof CAR_STATES)[number];

/** Pose trên mặt đất, mét và rad. */
export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly th: number;
}

/** Một điểm trên lộ trình: pose đích + chiều đi (tiến/lùi) + tốc độ cho phép. */
export interface RoutePoint {
  readonly pose: Pose;
  /** `forward` = tiến, `reverse` = lùi (FE §4.3: vào ô tiến, ra ô lùi). */
  readonly gear: 'forward' | 'reverse';
  /** Tốc độ tối đa trên đoạn này, m/s (thao tác trong ô ≤ 5 km/h). */
  readonly v_max: number;
}

/** Lộ trình = chuỗi đoạn trên đồ thị làn + thao tác vào/ra ô (FE §4.3). */
export interface Route {
  /** Id làn gốc của từng đoạn, rỗng nếu là thao tác trong ô. */
  readonly aisles: readonly string[];
  readonly points: readonly RoutePoint[];
  /** Tổng chiều dài, m — dùng để đo `gap` dọc đường (FE §4.4.1). */
  readonly length_m: number;
  /** Mục tiêu: ô đích hoặc cổng ra. */
  readonly target: { readonly kind: 'slot'; readonly slot: SlotId } | { readonly kind: 'exit' };
  /** Quãng đường bắt đầu thao tác vào ô (chuyển `driving_to_slot` → `parking_in`). */
  readonly slot_start_s?: number;
  /** Quãng đường kết thúc thao tác ra ô (chuyển `leaving_slot` → `driving_to_exit`). */
  readonly maneuver_end_s?: number;
}

/** Một xe trong mô phỏng. */
export interface CarState {
  /** V001, V002, … (FE §4.2). */
  readonly id: string;
  readonly model: CarModel;
  readonly color: CarColor;
  /** Chiều dài đã nhân hệ số tỉ lệ, m. */
  readonly length: number;
  /** Chiều rộng đã nhân hệ số tỉ lệ, m. */
  readonly width: number;
  /** Hệ số tỉ lệ thực đã chặn theo ô (C5, D4). */
  readonly scale: number;
  readonly pose: Pose;
  /** Tốc độ có dấu, m/s (âm = đang lùi). */
  readonly v: number;
  readonly state: CarStateName;
  /** Ô đang nhắm tới hoặc đang đỗ; `null` khi chỉ đi qua. */
  readonly slot: SlotId | null;
  /** Lộ trình hiện tại; `undefined` khi chưa lập hoặc đã ra khỏi bãi. */
  readonly route?: Route;
  /**
   * Tốc độ người dùng đặt cho xe này, m/s (scenario `default_speed_kmh` hoặc
   * `set_speed`). `gt_events.csv` cột `speed_kmh` lấy đúng giá trị này, không lấy
   * tốc độ lớn nhất quan sát được (REPORT_P5a #2).
   */
  readonly desired_speed_mps?: number;
  /** Quãng đường đã đi trên `route`, m — dùng cho bám đường và khoảng hở. */
  readonly route_s?: number;
  /** Số frame liên tiếp xe đứng yên (bộ đếm cảnh báo kẹt, FE §4.4.5). */
  readonly still_frames?: number;
  /**
   * P17e — frame bắt đầu chế độ **lách** (ghost pass), `undefined` khi không lách.
   *
   * Xe đứng yên ≥ `GHOST_AFTER_FRAMES` (6 s) mà vẫn bị chặn thì được phép đi xuyên qua đúng những
   * xe đang chặn nó, để bảo đảm không xe nào kẹt mãi. Xem `engine.ts` phần `ghostPass`.
   */
  readonly ghost_since_frame?: number;
  /** P17e — `route_s` lúc bắt đầu lách, m. Dùng để biết đã đi thêm ≥ 1 thân xe chưa. */
  readonly ghost_from_route_s?: number;
  /** Hết frame này thì thôi leo thang `park_clip` (ANS_13): giữ leo thang liên tục sau lần kích hoạt đầu. */
  readonly clip_escalated_until?: number;
  /** Thời gian đỗ theo yêu cầu `add_car.park_s`, giây (rỗng = đỗ tới khi có lệnh rời). */
  readonly park_s?: number;
  /** Frame tự động rời ô (chỉ có khi `park_s` được đặt). */
  readonly park_until_frame?: number;
}

/** Vùng đã giữ cho thao tác vào/ra ô (C7, D8: tất cả hoặc không). */
export interface Reservation {
  /** Xe giữ vùng. */
  readonly car_id: string;
  /** Ô liên quan. */
  readonly slot: SlotId;
  /** Đa giác vùng quét, m. */
  readonly polygon: readonly Vec2[];
  /** Frame bắt đầu giữ. */
  readonly since_frame: number;
  /** Thao tác giữ vùng. */
  readonly op: 'park_in' | 'leave_out';
}

/** Loại cảnh báo hiện trên thanh trạng thái + ghi `export_log.json` (FE §4.4.5, D8). */
export const WARNING_KINDS = [
  'collision',
  'stuck',
  'slot_occupied',
  'gate_queue_long',
  'event_rejected',
  /**
   * Dung sai có kiểm soát (ANS_4): xe đang vào/ra ô ở hàng 1–2 lấn vào **xe đã đỗ ở ô kề
   * cùng hàng**. Không phải lỗi lập trình; phải đếm và báo, không im lặng.
   */
  'park_clip',
  /** Leo thang `park_clip` (ANS_13): xe kẹt ≥ 4 s chỉ vì xe đỗ ô kề cùng hàng, trần tạm nâng tới 0,35 m. */
  'park_clip_escalated',
  /**
   * P17e — **xe lách** (ghost pass): xe đứng yên ≥ 6 s được phép đi xuyên qua đúng những xe đang
   * chặn nó, để bảo đảm "trường hợp nào cũng không kẹt". Đây là dung sai **có chủ đích và có đếm**,
   * không phải lỗi lập trình; mọi va chạm trong lúc lách chỉ giữa xe lách với xe nó lách qua đều
   * phân loại là `ghost_pass`, không phải `collision`.
   */
  'ghost_pass',
] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

export interface Warning {
  readonly frame: number;
  readonly kind: WarningKind;
  /** Thông báo tiếng Việt hiện thẳng lên UI. */
  readonly message: string;
  /** Xe/ô liên quan nếu có. */
  readonly car_id?: string;
  readonly slot?: SlotId;
  /** Chỉ `park_clip`: ô kề của xe đã đỗ bị lấn (ANS_4 mục 4). */
  readonly neighbour_slot?: SlotId;
  /** Chỉ `park_clip`: độ sâu xuyên theo SAT, m (ANS_4 mục 2: tối đa 0,5 m). */
  readonly depth_m?: number;
  /** Chỉ `park_clip`: id xe đã đỗ ở ô kề. */
  readonly neighbour_car_id?: string;
}

/**
 * Trạng thái RNG: mỗi mục đích một luồng riêng (FE §4.1, C3) để thêm sự kiện
 * không xáo các lần bốc khác.
 */
export interface RngStreams {
  /** mulberry32 state 32-bit của từng luồng. */
  readonly placement: number;
  readonly color: number;
  readonly model: number;
  readonly slot: number;
  readonly noise: number;
  readonly misc: number;
}

/** Tên luồng RNG. */
export type RngStreamName = keyof RngStreams;

/**
 * Môi trường đã nội suy tại frame hiện tại (FE §6).
 *
 * Không nằm trong `SimState` (contract C-A chốt 5 trường) vì môi trường không được
 * ảnh hưởng GT: lớp render tự gọi `interpolateEnv(scenario.env.keyframes, frame * DT_S)`.
 */
export interface EnvAtFrame {
  readonly hour: number;
  readonly weather: EnvKeyframe['weather'];
  readonly intensity: number;
  readonly wet: number;
  readonly fog: number;
}

/** Trạng thái mô phỏng tại một frame. Bất biến — `step` trả bản mới. */
export interface SimState {
  readonly frame: number;
  readonly cars: readonly CarState[];
  readonly reservations: readonly Reservation[];
  readonly rngState: RngStreams;
  readonly warnings: readonly Warning[];
}

/**
 * Có đang bị tạm dừng vì va chạm không (FE §4.4.4).
 *
 * Suy ra từ `warnings` để `SimState` giữ đúng 5 trường của contract C-A, không thêm
 * trạng thái thứ hai có thể lệch với cảnh báo.
 */
export function isHalted(state: SimState): boolean {
  return state.warnings.some((warning) => warning.kind === 'collision');
}

/** Lịch sử các frame đã chạy, dùng để tính `gt_events.csv`. */
export type SimHistory = readonly SimState[];

/** Cặp (frame, sự kiện) đưa vào `step`. */
export interface EventsAtFrame {
  readonly frame: number;
  readonly events: readonly SimEvent[];
}

/**
 * Tạo trạng thái ban đầu từ bãi + kịch bản (FE §4.2, §5; D4).
 *
 * Hợp đồng: thuần, tất định theo `scenario.seed`; xe đỗ sẵn bắt đầu ở `parked`
 * với pose khớp tâm/hướng ô đã chọn ở `scenario.initial.placement`.
 */
export function createState(lot: LotMap, scenario: Scenario): SimState {
  return createSimState(lot, scenario);
}

/**
 * Tiến một bước 0,04 s (FE §4.1, §4.3–§4.4).
 *
 * Hợp đồng: **thuần**, không sửa `state`; áp sự kiện của đúng frame này trước khi
 * tích phân chuyển động; trả state mới với `frame + 1`.
 *
 * `lot` được truyền tường minh vì `SimState` (contract chốt 5 trường) không mang
 * bản đồ; mọi trạng thái thật vẫn nằm trong `state`.
 */
export function step(
  lot: LotMap,
  state: SimState,
  eventsAtFrame: EventsAtFrame,
): SimState {
  return advanceSimState(lot, state, eventsAtFrame, DT_S);
}

/**
 * Một dòng `gt_frames.csv` của frame hiện tại (FE §4.6, C9, D10).
 *
 * Hợp đồng: tính từ toạ độ thật trong `sim/`, độc lập render/nhiễu; cột ô = 1 khi
 * **tâm xe nằm trong đa giác ô**. `mode` quyết định nhãn `cam1`/`cam2`.
 */
export function gtRow(
  lot: LotMap,
  state: SimState,
  mode: CameraMode,
): GtFrameRow {
  return computeGtRow(lot, state, mode);
}

/**
 * Toàn bộ `gt_events.csv` từ lịch sử đã chạy (FE §4.6, D10).
 *
 * Hợp đồng: một dòng mỗi chu trình xe; frame cổng vào/ra tính theo world.
 */
export function gtEvents(lot: LotMap, history: SimHistory): GtEventRow[] {
  return [...computeGtEvents(lot, history)];
}

/** Báo "chưa cài đặt" cho phần còn thiếu. Không bao giờ trả giá trị giả. */
export function notImplemented(what: string): never {
  throw new SimError(`Chưa cài đặt: ${what}`);
}

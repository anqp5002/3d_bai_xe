/**
 * Sinh N sự kiện `add_car` cho form "Thêm xe" (P14a / BRIEF_P14 lỗi 1+2).
 *
 * Hàm **thuần**: không React/DOM, không `Math.random`, không đọc đồng hồ. Mọi ngẫu nhiên đi qua
 * `mulberry32(seed)` của `sim/rng`, nên cùng seed + cùng đầu vào ⇒ cùng danh sách sự kiện
 * (đúng R3/C3, và test được bằng Node).
 *
 * Vì sao tách khỏi `simStore`: phần khó là **quyết định cái gì hợp lệ và cái gì bị từ chối**
 * (ô trống, D9 thứ tự frame, giãn cách, giới hạn 1–50). Tách ra thì test được từng ca mà không
 * phải dựng cả store.
 */

import type { CarColor, CarModel } from '../contracts/sim';
import type { SlotId } from '../contracts/lot';
import type { SimEvent } from '../contracts/events';
import { addCarEvent } from './scenarioModel';
import { mulberry32 } from '../sim/rng';

/** Số xe tối thiểu / tối đa mỗi lần thêm (TASK: 1–50). */
export const ADD_CAR_MIN = 1;
export const ADD_CAR_MAX = 50;

/** Tốc độ hợp lệ, km/h (TASK: 5–20). */
export const ADD_SPEED_MIN_KMH = 5;
export const ADD_SPEED_MAX_KMH = 20;

/** Giãn cách mặc định giữa hai xe, giây (TASK: mặc định 2). */
export const ADD_GAP_DEFAULT_S = 2;

/** FPS của sim; đổi giây → frame. */
const FPS = 25;

/** Cách chọn ô khi N > 1. */
export type SlotPickMode =
  /** N ô ngẫu nhiên trong các ô trống. */
  | 'random'
  /** Lần lượt theo danh sách ô người dùng đã chọn (phải chọn ≥ N ô). */
  | 'from-list';

/** Một xe bị từ chối, kèm lý do đọc được. */
export interface RejectedCar {
  /** Thứ tự trong lần thêm (1-based). */
  readonly index: number;
  readonly reason: string;
}

/** Kết quả một lần thêm. */
export interface AddCarsPlan {
  /** Sự kiện sinh ra, đã sắp theo frame tăng dần (đúng thứ tự append). */
  readonly events: readonly SimEvent[];
  /** Xe không thêm được + lý do (rỗng = tất cả thành công). */
  readonly rejected: readonly RejectedCar[];
  /** Frame của từng xe đã nhận, để UI hiện "đã thêm V00x ở frame N". */
  readonly acceptedFrames: readonly number[];
}

export interface AddCarsInput {
  /** Tổng số xe muốn thêm. */
  readonly count: number;
  /** Frame bắt đầu (frame của xe đầu tiên). */
  readonly startFrame: number;
  /** Giãn cách giữa hai xe, giây. */
  readonly gapSeconds: number;
  /** Tốc độ, km/h. */
  readonly speedKmh: number;
  /** Chế độ chọn ô. */
  readonly mode: SlotPickMode;
  /** Ô người dùng chọn tay (dùng cho `from-list`, và cho N = 1). */
  readonly chosenSlots: readonly SlotId[];
  /** Ô còn trống tại frame hiện tại (do store tính). */
  readonly freeSlots: readonly SlotId[];
  /** Frame cuối của kịch bản — không sinh sự kiện sau frame này. */
  readonly durationFrames: number;
  /** `null` = ngẫu nhiên. */
  readonly model: CarModel | null;
  readonly color: CarColor | null;
  /** Seed tất định (seed kịch bản + một salt cố định do caller chọn). */
  readonly seed: number;
}

const MODELS: readonly CarModel[] = ['sedan', 'suv', 'hatch'];
const COLORS: readonly CarColor[] = [
  'white',
  'black',
  'silver',
  'gray',
  'red',
  'blue',
  'green',
  'sand',
];

/** `n` phần tử ngẫu nhiên (không trùng) từ `items`, tất định theo `seed`. */
function pickRandom<T>(
  items: readonly T[],
  n: number,
  seed: number,
): { picked: T[]; skipped: number } {
  const pool = [...items];
  const picked: T[] = [];
  let state = seed >>> 0;
  while (picked.length < n && pool.length > 0) {
    const draw = mulberry32(state)();
    state = Math.floor(draw * 0x100000000) >>> 0;
    const index = Math.floor(draw * pool.length);
    const [taken] = pool.splice(Math.min(index, pool.length - 1), 1);
    picked.push(taken);
  }
  return { picked, skipped: n - picked.length };
}

/**
 * Sinh danh sách sự kiện. **Không** ném lỗi vì dữ liệu người dùng nhập; mọi ca không thoả
 * được ghi vào `rejected` kèm lý do (BRIEF: "báo rõ xe nào bị từ chối và lý do, không im lặng").
 */
export function planAddCars(input: AddCarsInput): AddCarsPlan {
  const rejected: RejectedCar[] = [];
  const events: SimEvent[] = [];
  const acceptedFrames: number[] = [];

  const count = Math.floor(input.count);
  if (!Number.isFinite(input.count) || count < ADD_CAR_MIN || count > ADD_CAR_MAX) {
    return {
      events: [],
      rejected: [
        {
          index: 1,
          reason: `số xe phải từ ${String(ADD_CAR_MIN)} đến ${String(ADD_CAR_MAX)}, nhận ${String(input.count)}`,
        },
      ],
      acceptedFrames: [],
    };
  }

  const speed = input.speedKmh;
  if (!Number.isFinite(speed) || speed < ADD_SPEED_MIN_KMH || speed > ADD_SPEED_MAX_KMH) {
    return {
      events: [],
      rejected: [
        {
          index: 1,
          reason: `tốc độ phải từ ${String(ADD_SPEED_MIN_KMH)} đến ${String(ADD_SPEED_MAX_KMH)} km/h, nhận ${String(input.speedKmh)}`,
        },
      ],
      acceptedFrames: [],
    };
  }

  const gapFrames = Math.round(input.gapSeconds * FPS);
  if (!Number.isFinite(input.gapSeconds) || gapFrames < 0) {
    return {
      events: [],
      rejected: [{ index: 1, reason: `giãn cách phải ≥ 0 giây, nhận ${String(input.gapSeconds)}` }],
      acceptedFrames: [],
    };
  }

  // Chọn ô: mode `from-list` ⇒ theo danh sách người dùng; `random` ⇒ bốc từ ô trống.
  // N = 1 mà người dùng đã chọn ô thì tôn trọng ô đó, chưa chọn thì bốc ngẫu nhiên.
  let slots: SlotId[];
  if (input.mode === 'from-list') {
    if (input.chosenSlots.length < count) {
      return {
        events: [],
        rejected: [
          {
            index: 1,
            reason:
              `cần ${String(count)} ô nhưng chỉ chọn ${String(input.chosenSlots.length)} — ` +
              'chọn thêm ô trên khung xem hoặc đổi sang "N ô ngẫu nhiên"',
          },
        ],
        acceptedFrames: [],
      };
    }
    slots = input.chosenSlots.slice(0, count);
  } else if (count === 1 && input.chosenSlots.length >= 1) {
    // Một xe + người dùng đã chọn ô cụ thể ⇒ dùng ô đó (không bốc ngẫu nhiên đè lên lựa chọn).
    slots = input.chosenSlots.slice(0, 1);
  } else {
    const { picked, skipped } = pickRandom(input.freeSlots, count, input.seed);
    slots = picked;
    if (skipped > 0) {
      rejected.push({
        index: picked.length + 1,
        reason: `chỉ còn ${String(input.freeSlots.length)} ô trống, thiếu ${String(skipped)} ô`,
      });
    }
  }

  // Sinh từng sự kiện, kiểm D9 (frame tăng dần) và biên kịch bản.
  let previousFrame = -1;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const frame = Math.round(input.startFrame) + index * gapFrames;
    const ordinal = index + 1;
    if (!input.freeSlots.includes(slot)) {
      rejected.push({ index: ordinal, reason: `ô ${slot} không còn trống` });
      previousFrame = Math.max(previousFrame, frame);
      continue;
    }
    // Kịch bản chạy frame 0 … durationFrames-1 (xem `runExport`: `history.length === totalFrames`).
    // Frame >= durationFrames không bao giờ được mô phỏng ⇒ sự kiện sẽ mất im lặng.
    if (frame < 0 || frame >= input.durationFrames) {
      rejected.push({
        index: ordinal,
        reason: `frame ${String(frame)} ngoài phạm vi kịch bản (0 … ${String(input.durationFrames - 1)})`,
      });
      previousFrame = Math.max(previousFrame, frame);
      continue;
    }
    if (frame < previousFrame) {
      rejected.push({
        index: ordinal,
        reason: `frame ${String(frame)} trước sự kiện trước (${String(previousFrame)}) — D9 cấm`,
      });
      continue;
    }
    const rng = mulberry32((input.seed ^ (ordinal * 0x9e3779b1)) >>> 0);
    const roll = rng();
    const model =
      input.model ?? MODELS[Math.min(MODELS.length - 1, Math.floor(roll * MODELS.length))];
    const roll2 = rng();
    const color =
      input.color ?? COLORS[Math.min(COLORS.length - 1, Math.floor(roll2 * COLORS.length))];
    events.push(addCarEvent(frame, slot, speed, model, color));
    acceptedFrames.push(frame);
    previousFrame = frame;
  }

  return { events, rejected, acceptedFrames };
}

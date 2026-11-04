/**
 * P17c — sinh kịch bản fuzz **tất định** từ seed cho engine sim (BRIEF_P17 mục "Bổ sung").
 *
 * Mỗi seed cho đúng một kịch bản, không dùng `Math.random`/đồng hồ: chạy lại cùng seed là
 * cùng file JSON, nên khi test đỏ chỉ cần ghi seed là tái hiện được.
 *
 * Tham số phủ đúng danh sách lead yêu cầu:
 * - đỗ sẵn **0–95 xe** ở ô ngẫu nhiên (không trùng ô);
 * - xe vào dồn dập, **gap 1–8 s**, tốc độ **5–20 km/h**, `park_s` **10–90 s**;
 * - `leave` lẻ và `leave_random` **hàng loạt cùng frame** (kể cả "cho N xe ra cùng lúc"),
 *   rải trong lúc xe còn đang vào để tạo chồng chéo vào/ra — đúng ca deadlock của P17;
 * - cuối video mọi xe đều xong việc: xe có lịch rời phải `exited`, xe đỗ sẵn không có lịch
 *   rời thì `parked` (bộ kiểm ở `fuzz.test.ts` chặn trạng thái trung gian ở frame cuối).
 *
 * Sức chứa: bãi có 100 ô, nên `n_parked + n_arrivals ≤ 98` để **không** có `add_car` bị từ
 * chối vì hết ô (từ chối vì hết ô là chuyện sức chứa, không phải deadlock — lẫn vào sẽ làm
 * test không bao giờ xanh được kể cả sau khi sửa engine).
 */

import type { LotMap } from '../contracts/lot';
import { SCENARIO_SCHEMA } from '../contracts/scenario';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { CarColor, CarModel } from '../contracts/sim';
import { CAR_COLORS, CAR_MODELS, CAR_SCALE_DEFAULT } from '../contracts/sim';
import { createNoiseConfig } from '../contracts/env';
import { FPS } from './constants';
import { mulberry32 } from './rng';

/** Seed của kịch bản fuzz thứ `index` (0-based) — cố định để tái hiện. */
export const FUZZ_SEED_BASE = 1;
/** Số kịch bản nghiệm thu P17 (BRIEF: ≥ 200). */
export const FUZZ_SEED_COUNT = 200;
/** Mặc định CI nhẹ; `FUZZ_N=200` cho nghiệm thu. */
export const FUZZ_DEFAULT_N = 20;

/** Ô hẹp hơn ngưỡng này chỉ nhận hatchback (D4) — giống `gen_load_suites.py`. */
const NARROW_SLOT_WIDTH_M = 2.1;
/** Trần sức chứa dùng khi sinh kịch bản: chừa 2 ô để không bao giờ hết ô. */
const CAPACITY_LIMIT = 98;
/** Xe đầu tiên vào ở giây này. */
const START_S = 5;
/** Chốt để video không dài vô ích: xe cuối cùng vào không muộn hơn giây này. */
const MAX_LAST_ARRIVAL_S = 305;
/** Dư sau sự kiện cuối cho xe vào ô, đỗ hết `park_s`, rồi ra khỏi bãi. */
const SETTLE_MARGIN_S = 240;

/** Một đợt cho xe đỗ sẵn rời đi (cùng frame). */
export interface LeaveBurst {
  readonly frame: number;
  /** Số xe gọi bằng `leave_random` (hàng loạt). */
  readonly n: number;
  /** Số xe gọi bằng `leave` lẻ ở đúng frame đó (kiểm "cùng frame"). */
  readonly manual: number;
}

/** Tham số đã bốc — in ra khi test đỏ để biết kịch bản nặng/ nhẹ. */
export interface FuzzPlan {
  readonly seed: number;
  readonly n_parked: number;
  readonly n_arrivals: number;
  readonly gap_s: number;
  readonly speed_kmh_min: number;
  readonly speed_kmh_max: number;
  readonly park_s_min: number;
  readonly park_s_max: number;
  readonly leave_bursts: readonly LeaveBurst[];
  readonly last_event_s: number;
  readonly duration_s: number;
  readonly duration_frames: number;
}

export interface FuzzCase {
  readonly scenario: Scenario;
  readonly plan: FuzzPlan;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Seed kịch bản thứ `index` (0-based) — cùng `base` ⇒ cùng seed. */
export function fuzzSeed(index: number, base: number = FUZZ_SEED_BASE): number {
  return (base + index) >>> 0;
}

/** Sinh một kịch bản fuzz + tham số đã bốc. Tất định theo `seed`. */
export function buildFuzzScenario(seed: number, lot: LotMap): FuzzCase {
  const rng = mulberry32(seed);
  const int = (min: number, max: number): number =>
    min + Math.floor(rng() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];

  const nParked = int(0, 95);
  const gapS = round2(1 + rng() * 7);
  const room = Math.max(0, CAPACITY_LIMIT - nParked);
  const maxByTime = Math.max(1, Math.floor(MAX_LAST_ARRIVAL_S / gapS));
  const nArrivals = Math.min(room, maxByTime, int(1, 60));
  const speedMin = int(5, 12);
  const speedMax = int(speedMin, 20);
  const parkMin = int(10, 50);
  const parkMax = int(parkMin, 90);

  // ---- Xe đỗ sẵn: ô ngẫu nhiên không trùng ----
  const reachable = lot.slots.filter((slot) => slot.reachable);
  const shuffled = [...reachable];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const value = shuffled[index];
    shuffled[index] = shuffled[swap];
    shuffled[swap] = value;
  }
  const parkedSlots = shuffled.slice(0, nParked);
  const placement = parkedSlots.map((slot, index) => {
    const narrow = slot.width_m < NARROW_SLOT_WIDTH_M;
    const model: CarModel = narrow ? 'hatch' : pick(CAR_MODELS);
    const color: CarColor = pick(CAR_COLORS);
    return {
      slot: slot.id,
      car_id: `V${String(index + 1).padStart(3, '0')}`,
      model,
      color,
    };
  });

  // ---- Lịch xe vào ----
  const arrivals: SimEvent[] = [];
  for (let index = 0; index < nArrivals; index += 1) {
    arrivals.push({
      frame: Math.round((START_S + index * gapS) * FPS),
      type: 'add_car',
      params: {
        slot: 'random_free',
        speed_kmh: int(speedMin, speedMax),
        model: pick(CAR_MODELS),
        color: pick(CAR_COLORS),
        park_s: int(parkMin, parkMax),
      },
    });
  }
  const lastArrivalS = START_S + Math.max(0, nArrivals - 1) * gapS;

  // ---- Đợt cho xe đỗ sẵn rời đi (chồng chéo với lúc xe vào) ----
  const bursts: LeaveBurst[] = [];
  const burstEvents: SimEvent[] = [];
  if (nParked > 0) {
    const burstCount = int(2, 4);
    const firstS = Math.min(20, Math.max(START_S, lastArrivalS));
    // Giãn các đợt ít nhất ~6 s để không dồn nhiều `leave_random` vào cùng một frame
    // (đợt "cả bãi ra cùng lúc" vẫn có ở đợt cuối, đúng yêu cầu của lead).
    const spanS = Math.max(24, lastArrivalS - firstS);
    for (let index = 0; index < burstCount; index += 1) {
      const at = round2(firstS + (spanS * index) / burstCount);
      const frame = Math.round(at * FPS);
      // Đợt đầu: vài `leave` lẻ đúng frame đó + `leave_random` cùng frame.
      const manual = index === 0 ? Math.min(int(2, 3), nParked) : 0;
      const n = Math.min(nParked, int(5, 40));
      bursts.push({ frame, n, manual });
    }
    // Đợt cuối: cho TẤT CẢ xe đỗ sẵn còn lại ra, sau khi hết xe vào 30 s.
    const finalFrame = Math.round((lastArrivalS + 30) * FPS);
    bursts.push({ frame: finalFrame, n: nParked, manual: 0 });

    // Xe gọi `leave` lẻ: lấy từ đầu danh sách đỗ sẵn, mỗi xe một lần (không trùng).
    let manualCursor = 0;
    bursts.forEach((burst) => {
      for (let index = 0; index < burst.manual; index += 1) {
        const car = placement[manualCursor % placement.length];
        manualCursor += 1;
        if (car !== undefined) {
          burstEvents.push({
            frame: burst.frame,
            type: 'leave',
            params: { car_id: car.car_id },
          });
        }
      }
      if (burst.n > 0) {
        burstEvents.push({
          frame: burst.frame,
          type: 'leave_random',
          params: { n: burst.n },
        });
      }
    });
  }

  // ---- Gộp + sắp xếp: cùng frame thì `leave` lẻ trước `leave_random` trước `add_car` ----
  const priority: Readonly<Record<SimEvent['type'], number>> = {
    leave: 0,
    leave_random: 1,
    set_speed: 2,
    env_keyframe: 3,
    noise: 4,
    add_car: 5,
    add_cars: 6,
  };
  const events = [...burstEvents, ...arrivals].sort(
    (left, right) =>
      left.frame - right.frame || priority[left.type] - priority[right.type],
  );

  const lastEventS = Math.max(lastArrivalS, ...bursts.map((burst) => burst.frame / FPS));
  const durationS = Math.ceil(lastEventS + parkMax + SETTLE_MARGIN_S);
  const durationFrames = durationS * FPS;

  const scenario: Scenario = {
    schema: SCENARIO_SCHEMA,
    lot: lot.name,
    seed,
    car_scale: CAR_SCALE_DEFAULT,
    default_speed_kmh: int(5, 20),
    camera_mode: '2cam',
    initial: { n_parked: placement.length, placement },
    env: {
      preset: 'E1',
      keyframes: [{ t_s: 0, hour: 12, weather: 'sun', intensity: 0.8 }],
    },
    noise: createNoiseConfig(seed),
    events,
    duration_frames: durationFrames,
  };

  return {
    scenario,
    plan: {
      seed,
      n_parked: nParked,
      n_arrivals: nArrivals,
      gap_s: gapS,
      speed_kmh_min: speedMin,
      speed_kmh_max: speedMax,
      park_s_min: parkMin,
      park_s_max: parkMax,
      leave_bursts: bursts,
      last_event_s: round2(lastEventS),
      duration_s: durationS,
      duration_frames: durationFrames,
    },
  };
}

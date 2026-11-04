/**
 * P17c — fuzz test engine sim: **≥ 200 kịch bản ngẫu nhiên, 0 kẹt** (BRIEF_P17 "Bổ sung").
 *
 * Đây là cổng nghiệm thu P17: engine phải chạy sạch **mọi** kịch bản sinh từ seed cố định,
 * không chỉ 12 bộ tải A/B/C. Mỗi kịch bản chạy engine thật (`createSimState` +
 * `advanceSimState`) rồi kiểm bằng đúng bộ kiểm của P5e/P10a (`stallCheck`), nên không thể
 * "xanh giả" bằng cách chỉ nhìn frame cuối.
 *
 * Điều kiện ĐẠT của một seed (giống BRIEF):
 * - 0 va chạm (`collision`);
 * - 0 kẹt giữa chừng (`findStalls`) và 0 cảnh báo `stuck`;
 * - 0 xe còn kẹt ở frame cuối (`findStillAtEnd`);
 * - 0 bỏ hàng chờ (`findAbandonedQueue` + `queueAtEnd`);
 * - 0 sự kiện bị từ chối (kịch bản đã chừa 2 ô trống nên hết ô **không** phải lý do hợp lệ);
 * - mọi xe xong việc trước hết video: frame cuối không còn xe ở trạng thái trung gian
 *   (`queued`/`entering`/`driving_to_slot`/`parking_in`/`leaving_slot`/`driving_to_exit`).
 *
 * Chạy:
 * ```
 * cd sim3d/web
 * npx vitest run src/sim/fuzz.test.ts                      # 20 kịch bản (CI nhẹ)
 * FUZZ_N=200 npx vitest run src/sim/fuzz.test.ts           # nghiệm thu P17
 * FUZZ_SHARD=1/4 FUZZ_N=200 npx vitest run src/sim/fuzz.test.ts   # chia 4 shard
 * ```
 * Cùng seed ⇒ cùng kết quả; seed đỏ in ra kèm tham số để tái hiện ngay.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { CarStateName, SimState, Warning } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { advanceSimState, createSimState } from './engine';
import { DT_S } from './constants';
import { buildFuzzScenario, fuzzSeed, FUZZ_DEFAULT_N } from './fuzzScenario';
import type { FuzzPlan } from './fuzzScenario';
import {
  describeQueue,
  describeStalls,
  findAbandonedQueue,
  findStalls,
  findStillAtEnd,
  queueAtEnd,
} from './stallCheck';
import type { QueueFinding, StallFinding } from './stallCheck';

const lot = lotJson as unknown as LotMap;

/** Trạng thái trung gian: còn ở đây khi hết video = chưa xong việc. */
const TRANSIENT_STATES: ReadonlySet<CarStateName> = new Set([
  'queued',
  'entering',
  'driving_to_slot',
  'parking_in',
  'leaving_slot',
  'driving_to_exit',
]);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} phải là số nguyên ≥ 1, nhận "${raw}"`);
  }
  return value;
}

/** `FUZZ_SHARD=i/n` (1-based) — trả `null` khi không chia shard. */
function parseShard(raw: string | undefined): { index: number; count: number } | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (match === null) {
    throw new Error(`FUZZ_SHARD phải có dạng i/n, nhận "${raw}"`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index < 1 || count < 1 || index > count) {
    throw new Error(`FUZZ_SHARD ngoài phạm vi: "${raw}" (cần 1 ≤ i ≤ n)`);
  }
  return { index, count };
}

interface FuzzMetrics {
  readonly frames: number;
  /** Đã dừng sớm vì gặp lỗi (không chạy hết video) — chỉ để báo, không phải điều kiện ĐẠT. */
  readonly stopped_early: boolean;
  readonly stopped_at: number;
  readonly cars: number;
  readonly exited: number;
  readonly parked: number;
  readonly transient: readonly {
    readonly id: string;
    readonly state: CarStateName;
    readonly slot: string | null;
  }[];
  /** Frame cuối cùng còn xe ở trạng thái trung gian (để biết video dư bao nhiêu). */
  readonly settled_frame: number;
  readonly collisions: readonly Warning[];
  readonly stuck: readonly Warning[];
  readonly rejected: readonly Warning[];
  readonly otherWarnings: readonly string[];
  readonly stalls: readonly StallFinding[];
  readonly still: readonly StallFinding[];
  readonly abandoned: readonly QueueFinding[];
  readonly queueEnd: readonly string[];
}

/** Chạy engine thật hết kịch bản rồi gom số đo (không assert — assert ở dưới). */
function runFuzzCase(seed: number): { plan: FuzzPlan; metrics: FuzzMetrics } {
  const { scenario, plan } = buildFuzzScenario(seed, lot);
  const frames = scenario.duration_frames;
  let state = createSimState(lot, scenario);
  const history: SimState[] = [state];
  const collisions: Warning[] = [];
  const stuck: Warning[] = [];
  const rejected: Warning[] = [];
  const otherWarnings: string[] = [];
  let settledFrame = 0;
  let stoppedEarly = false;
  let stoppedAt = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const due = scenario.events.filter((event) => event.frame === state.frame);
    state = advanceSimState(lot, state, { frame: state.frame, events: due }, DT_S);
    history.push(state);
    if (state.cars.some((car) => TRANSIENT_STATES.has(car.state))) {
      settledFrame = state.frame;
    }
    for (const warning of state.warnings) {
      if (warning.kind === 'collision') {
        collisions.push(warning);
      } else if (warning.kind === 'stuck') {
        stuck.push(warning);
      } else if (warning.kind === 'event_rejected') {
        rejected.push(warning);
      } else if (
        warning.kind !== 'park_clip' &&
        warning.kind !== 'park_clip_escalated'
      ) {
        otherWarnings.push(`${String(state.frame)}:${JSON.stringify(warning)}`);
      }
    }
    // Dừng sớm khi đã chắc chắn đỏ: kịch bản deadlock không cần chạy hết video
    // (mỗi frame deadlock rất đắt vì engine liên tục thử nhường/back-off).
    const abandonedNow =
      state.frame % 200 === 0 && findAbandonedQueue(history).length > 0;
    if (
      collisions.length > 0 ||
      stuck.length > 0 ||
      rejected.length > 0 ||
      abandonedNow
    ) {
      stoppedEarly = true;
      stoppedAt = state.frame;
      break;
    }
  }

  const last = history[history.length - 1];
  const transient = last.cars
    .filter((car) => TRANSIENT_STATES.has(car.state))
    .map((car) => ({ id: car.id, state: car.state, slot: car.slot }));

  return {
    plan,
    metrics: {
      frames,
      stopped_early: stoppedEarly,
      stopped_at: stoppedAt,
      cars: last.cars.length,
      exited: last.cars.filter((car) => car.state === 'exited').length,
      parked: last.cars.filter((car) => car.state === 'parked').length,
      transient,
      settled_frame: settledFrame,
      collisions,
      stuck,
      rejected,
      otherWarnings,
      stalls: findStalls(history),
      still: findStillAtEnd(history),
      abandoned: findAbandonedQueue(history),
      queueEnd: queueAtEnd(history),
    },
  };
}

function planLine(plan: FuzzPlan): string {
  return (
    `seed=${String(plan.seed)} n_parked=${String(plan.n_parked)} ` +
    `n_arrivals=${String(plan.n_arrivals)} gap=${String(plan.gap_s)}s ` +
    `speed=${String(plan.speed_kmh_min)}–${String(plan.speed_kmh_max)}km/h ` +
    `park_s=${String(plan.park_s_min)}–${String(plan.park_s_max)}s ` +
    `leave_bursts=[${plan.leave_bursts
      .map((burst) => `${String(burst.frame)}:${String(burst.n)}+${String(burst.manual)}`)
      .join(',')}] ` +
    `duration=${String(plan.duration_s)}s (${String(plan.duration_frames)} frame)`
  );
}

function summaryLine(plan: FuzzPlan, metrics: FuzzMetrics): string {
  return (
    `[fuzz ${String(plan.seed)}] ${planLine(plan)} → ` +
    `ran=${String(metrics.stopped_early ? metrics.stopped_at : metrics.frames)}/${String(metrics.frames)} ` +
    `cars=${String(metrics.cars)} exited=${String(metrics.exited)} ` +
    `parked=${String(metrics.parked)} collisions=${String(metrics.collisions.length)} ` +
    `stuck=${String(metrics.stuck.length)} stalls=${String(metrics.stalls.length)} ` +
    `stillEnd=${String(metrics.still.length)} abandoned=${String(metrics.abandoned.length)} ` +
    `queueEnd=${String(metrics.queueEnd.length)} rejected=${String(metrics.rejected.length)} ` +
    `settled=${String(metrics.settled_frame)}`
  );
}

/** Gói mọi vi phạm thành một thông báo đủ để tái hiện (seed + tham số + mẫu đầu). */
function failuresOf(plan: FuzzPlan, metrics: FuzzMetrics): string[] {
  const failures: string[] = [];
  if (metrics.stopped_early) {
    failures.push(
      `dừng sớm ở frame ${String(metrics.stopped_at)}/${String(metrics.frames)} (gặp lỗi, không chạy hết video)`,
    );
  }
  if (metrics.collisions.length > 0) {
    failures.push(
      `va chạm ${String(metrics.collisions.length)}: ` +
        JSON.stringify(metrics.collisions.slice(0, 3)),
    );
  }
  if (metrics.stuck.length > 0) {
    failures.push(
      `cảnh báo stuck ${String(metrics.stuck.length)}: ` +
        metrics.stuck
          .slice(0, 3)
          .map((warning) => `f${String(warning.frame)} ${warning.message}`)
          .join(' | '),
    );
  }
  if (metrics.stalls.length > 0) {
    failures.push(`kẹt giữa chừng ${String(metrics.stalls.length)}: ${describeStalls(metrics.stalls.slice(0, 5))}`);
  }
  if (metrics.still.length > 0) {
    failures.push(`còn kẹt ở frame cuối ${String(metrics.still.length)}: ${describeStalls(metrics.still.slice(0, 5))}`);
  }
  if (metrics.abandoned.length > 0) {
    failures.push(`bỏ hàng chờ ${String(metrics.abandoned.length)}: ${describeQueue(metrics.abandoned.slice(0, 5))}`);
  }
  if (metrics.queueEnd.length > 0) {
    failures.push(`còn queued ở frame cuối: ${metrics.queueEnd.slice(0, 8).join(', ')}`);
  }
  if (metrics.rejected.length > 0) {
    failures.push(
      `sự kiện bị từ chối ${String(metrics.rejected.length)}: ` +
        metrics.rejected
          .slice(0, 3)
          .map((warning) => `f${String(warning.frame)} ${warning.message}`)
          .join(' | '),
    );
  }
  if (metrics.transient.length > 0) {
    const where = metrics.stopped_early
      ? `frame dừng ${String(metrics.stopped_at)}`
      : 'frame cuối';
    failures.push(
      `chưa xong việc ở ${where} ${String(metrics.transient.length)}: ` +
        metrics.transient
          .slice(0, 10)
          .map((car) => `${car.id}(${car.state}${car.slot === null ? '' : `@${car.slot}`})`)
          .join(', '),
    );
  }
  if (metrics.otherWarnings.length > 0) {
    failures.push(
      `cảnh báo khác ${String(metrics.otherWarnings.length)}: ` +
        metrics.otherWarnings.slice(0, 3).join(' | '),
    );
  }
  if (failures.length > 0) {
    failures.unshift(`KỊCH BẢN ĐỎ — ${planLine(plan)}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------------------
// Chọn seed: FUZZ_N (mặc định 20) + FUZZ_SHARD=i/n
// ---------------------------------------------------------------------------------------
const total = envInt('FUZZ_N', FUZZ_DEFAULT_N);
const shard = parseShard(process.env.FUZZ_SHARD);
const allSeeds = Array.from({ length: total }, (_, index) => fuzzSeed(index));
const seeds =
  shard === null
    ? allSeeds
    : allSeeds.filter((_, index) => index % shard.count === shard.index - 1);

describe('fuzz engine sim — mọi kịch bản phải sạch (P17)', () => {
  it('có ít nhất một kịch bản trong shard này', () => {
    expect(seeds.length).toBeGreaterThan(0);
  });

  for (const seed of seeds) {
    it(
      `seed ${String(seed)}`,
      () => {
        const { plan, metrics } = runFuzzCase(seed);
        console.info(summaryLine(plan, metrics));
        const failures = failuresOf(plan, metrics);
        expect(failures).toEqual([]);
        // Video phải dư thời gian: mọi xe xong việc trước frame cuối ít nhất 1 s.
        expect(metrics.settled_frame).toBeLessThan(metrics.frames - 25);      },
      // BRIEF_P17: timeout mỗi kịch bản ≥ 300 s.
      300_000,
    );
  }
});

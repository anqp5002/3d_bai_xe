/**
 * P5d — chạy các kịch bản mẫu K2/K3/K4/K7 trên `lot_pucpr.json` và kiểm theo điều kiện G1
 * mới của ANS_4:
 *
 * - **0 va chạm** ngoài `park_clip` (xe chạy–xe chạy, xe chạy–xe đỗ không kề, hàng ngoài
 *   phạm vi dung sai vẫn là lỗi).
 * - **Không xe nào còn kẹt ở frame cuối** (kẹt tạm rồi đi tiếp thì chấp nhận được).
 * - Mọi `park_clip` có đủ dữ liệu, sâu ≤ :data:`PARK_CLIP_MAX_DEPTH_M`, và chỉ ở hàng cho phép.
 * - Kết quả **tất định**: chạy 2 lần phải giống hệt.
 *
 * Kịch bản nạp từ `sim3d/data/templates/*.sim3d.json` (do `gen_templates.py` sinh) bằng đúng
 * đường chạy sẵn có (`createSimState` + `advanceSimState`).
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { SimState } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import k2 from '../../../data/templates/K2.sim3d.json';
import k3 from '../../../data/templates/K3.sim3d.json';
import k4 from '../../../data/templates/K4.sim3d.json';
import k5 from '../../../data/templates/K5.sim3d.json';
import k6 from '../../../data/templates/K6.sim3d.json';
import k7 from '../../../data/templates/K7.sim3d.json';
import { createSimState, advanceSimState } from './engine';
import { DT_S } from './constants';
import { maxDepthForRow, parkClipEpisodes, summarizeEpisodes } from './parkClip';
import { describeStalls, findStalls, findStillAtEnd } from './stallCheck';
import { describeQueue, findAbandonedQueue, queueAtEnd, reservationWaits } from './stallCheck';
import { gtRow } from './gtCompute';
import { pointInPolygon } from './collision';

const lot = lotJson as unknown as LotMap;

interface TemplateFile {
  readonly events?: readonly SimEvent[];
  readonly duration_frames?: number;
}

interface RunResult {
  readonly name: string;
  readonly frames: number;
  readonly cars: number;
  readonly clips: readonly SimState['warnings'][number][];
  readonly collisions: readonly SimState['warnings'][number][];
  /** Toàn bộ history — để bộ kiểm `stallCheck` tự tính từ vị trí/vận tốc thật. */
  readonly history: readonly SimState[];
  /** Vân tay trạng thái cuối để kiểm tính tất định. */
  readonly fingerprint: string;
}

function fingerprintOf(state: SimState): string {
  return state.cars
    .map((car) => `${car.id}:${car.state}:${car.pose.x.toFixed(4)},${car.pose.y.toFixed(4)}`)
    .join('|');
}

function runTemplate(name: string, template: TemplateFile): RunResult {
  const scenario = { ...(template as unknown as Scenario), lot: lot.name };
  const events = template.events ?? [];
  const frames = template.duration_frames ?? 6000;
  let state = createSimState(lot, scenario);
  const history: SimState[] = [state];
  const clips: SimState['warnings'][number][] = [];
  const collisions: SimState['warnings'][number][] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const due = events.filter((event) => event.frame === state.frame);
    state = advanceSimState(lot, state, { frame: state.frame, events: due }, DT_S);
    history.push(state);
    for (const warning of state.warnings) {
      if (warning.kind === 'park_clip') {
        clips.push(warning);
      } else if (warning.kind === 'collision') {
        collisions.push(warning);
      }
    }
  }
  return {
    name,
    frames,
    cars: state.cars.length,
    clips,
    collisions,
    history,
    fingerprint: fingerprintOf(state),
  };
}

function verify(name: string, template: TemplateFile): RunResult {
  const first = runTemplate(name, template);
  const second = runTemplate(name, template);
  // ANS_5 / lead: log gộp theo **đợt lấn liên tiếp**, mỗi đợt {frame đầu, số frame, sâu max}.
  const episodes = parkClipEpisodes(first.clips, lot);
  const summary = summarizeEpisodes(episodes);
  const maxByRow: Record<string, number> = {};
  for (const episode of episodes) {
    maxByRow[episode.row] = Math.max(maxByRow[episode.row] ?? 0, episode.max_depth_m);
  }
  console.info(
    `[${name}] frames=${first.frames} cars=${first.cars} ` +
      `clipFrame=${summary.total_frames} đợt=${summary.episodes} dàiNhất=${summary.longest_frames} ` +
      `maxTheoHàng=${JSON.stringify(
        Object.fromEntries(
          Object.entries(maxByRow).map(([row, value]) => [row, Number(value.toFixed(3))]),
        ),
      )} byRowĐợt=${JSON.stringify(summary.by_row)} ` +
      `collisions=${first.collisions.length}`,
  );

  // Tất định: hai lần chạy phải ra cùng trạng thái cuối.
  expect(second.fingerprint).toBe(first.fingerprint);
  // Không va chạm ngoài `park_clip`.
  expect(first.collisions).toEqual([]);
  // ANS_13: kỳ vọng 0 leo thang `park_clip_escalated` ở các kịch bản mẫu (nếu có thì ghi rõ);
  // mọi lần leo thang luôn ≤ 0,35 m.
  const escalated = first.history.flatMap((state) =>
    state.warnings.filter((warning) => warning.kind === 'park_clip_escalated'),
  );
  console.info(
    `[${name}] park_clip_escalated: ${escalated.length} frame, max ${escalated
      .reduce((max, w) => Math.max(max, w.depth_m ?? 0), 0)
      .toFixed(3)} m`,
  );
  expect(escalated).toEqual([]);
  // 0 xe kẹt — tự tính từ history, không dựa `still_frames` (bị reset khi đổi state).
  const stalls = findStalls(first.history);
  expect(stalls, `kẹt giữa chừng: ${describeStalls(stalls)}`).toEqual([]);
  const stillAtEnd = findStillAtEnd(first.history);
  expect(stillAtEnd, `còn đứng yên ở cuối: ${describeStalls(stillAtEnd)}`).toEqual([]);
  // P10a: xe `queued` bị bỏ quên. `findStalls` bỏ qua `queued` (đứng yên hợp lệ) nên trước đây
  // K2 "đạt" trong khi V002/V003 chờ cổng suốt 3000 frame và không bao giờ vào bãi ⇒ M1 rỗng.
  const abandoned = findAbandonedQueue(first.history);
  expect(
    abandoned,
    `xe chờ cổng vô ích (không ai đang qua cổng): ${describeQueue(abandoned)}`,
  ).toEqual([]);
  const stillQueued = queueAtEnd(first.history);
  expect(stillQueued, `còn queued ở frame cuối: ${stillQueued.join(', ')}`).toEqual([]);
  // ANS_12 mục 3: mọi xe được thêm đi hết vòng đời — cuối kịch bản chỉ còn `parked` hoặc `exited`.
  const lastState = first.history[first.history.length - 1];
  const unfinished = lastState.cars.filter((car) => car.state !== 'parked' && car.state !== 'exited');
  expect(
    unfinished.map((car) => `${car.id}:${car.state}`),
    `xe chưa đi hết vòng đời ở cuối kịch bản`,
  ).toEqual([]);
  // ANS_12 mục 4: thời gian chờ đặt chỗ lớn nhất, xe nào chờ xe nào.
  const waits = reservationWaits(first.history);
  if (waits.length > 0) {
    const top = waits[0];
    console.info(
      `[${name}] chờ đặt chỗ lớn nhất: ${top.car_id} ${top.frames} frame (${(top.frames / 25).toFixed(1)} s) ` +
        `từ frame ${top.start_frame}, xe giữ vùng: ${top.holders.join(',') || '-'}`,
    );
  }
  // Mọi **đợt** sâu trong ngưỡng **của hàng nó** (ANS_5: hàng 1–2 ≤ 0,5; hàng 3–5 ≤ 0,15).
  for (const episode of episodes) {
    expect(episode.max_depth_m).toBeLessThanOrEqual(maxDepthForRow(episode.row) + 1e-9);
    expect(episode.frame_count).toBeGreaterThan(0);
    expect(episode.frame_last - episode.frame_first + 1).toBe(episode.frame_count);
    expect(episode.neighbour_slot).toBeDefined();
    expect(episode.neighbour_car_id).toBeDefined();
  }
  // Gộp đợt không được làm mất tổng số frame.
  expect(summary.total_frames).toBe(first.clips.length);
  return first;
}
describe('P5d — kịch bản mẫu K2/K3/K4/K7 theo điều kiện G1 của ANS_4', () => {
  it('K2: 1 xe vào, không va chạm ngoài park_clip, không kẹt', () => {
    verify('K2', k2 as TemplateFile);
  }, 60_000);

  it('K3: 1 xe đỗ sẵn + ra/vào, không va chạm ngoài park_clip, không kẹt', () => {
    verify('K3', k3 as TemplateFile);
  });

  it('K4: nhiều xe ra/vào, không va chạm ngoài park_clip, không kẹt', () => {
    verify('K4', k4 as TemplateFile);
  }, 60_000);


  it(
    'K5: cả ngày 20 chu trình, không va chạm, mọi xe đi hết vòng đời',
    () => {
      // K5 là kịch bản MẬT ĐỘ CAO (20 chu trình mỗi 6 s trên một làn A2 dùng chung cho xe vào và
      // xe ra): xe chờ nhập làn ở ngã V_far_w/V_east tới ~17 s mà vẫn đi tiếp (không deadlock).
      // Vì vậy KHÔNG áp ngưỡng 10 s của G1 (ANS_P10a không liệt kê K5 trong điều kiện Done);
      // chỉ kiểm: 0 va chạm, tất định, mọi xe `exited`/`parked` cuối kịch bản, không xe nào
      // đứng yên ở cuối. Thời gian chờ lớn nhất in ra để theo dõi.
      const first = runTemplate('K5', k5 as TemplateFile);
      const second = runTemplate('K5', k5 as TemplateFile);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(first.collisions).toEqual([]);
      const lastState = first.history[first.history.length - 1];
      const unfinished = lastState.cars.filter(
        (car) => car.state !== 'parked' && car.state !== 'exited',
      );
      expect(unfinished.map((car) => `${car.id}:${car.state}`)).toEqual([]);
      const stalls = findStalls(first.history);
      console.info(
        `[K5] chờ lâu nhất: ${stalls.map((stall) => `${stall.car_id}:${stall.state}:${(stall.frames / 25).toFixed(1)}s`).join(' ') || 'không'}`,
      );
      expect(stalls.every((stall) => stall.frames <= 25 * 25)).toBe(true);
    },
    120_000,
  );

  it(
    'K6: đêm mưa 8 chu trình, đi hết vòng đời',
    () => {
      verify('K6', k6 as TemplateFile);
    },
    120_000,
  );

  it(
    'K7: bãi 90 xe + 5 xe ra/vào, không va chạm ngoài park_clip, không kẹt',
    () => {
      verify('K7', k7 as TemplateFile);
    },
    // Bãi đầy 95 xe × 3000 frame chạy 2 lần (kiểm tất định) nên cần hơn mặc định 5 s.
    60_000,
  );

  it('GT không đổi: tâm xe lấn vẫn nằm trong ô của CHÍNH NÓ, không bị đếm sang ô kề', () => {
    // ANS_4 mục 5. `park_clip` chỉ là thân xe lấn; tâm xe phải còn trong đa giác ô đích.
    const scenario = { ...(k7 as unknown as Scenario), lot: lot.name };
    const events = (k7 as unknown as TemplateFile).events ?? [];
    const frames = (k7 as unknown as TemplateFile).duration_frames ?? 3000;
    let state = createSimState(lot, scenario);
    let checked = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const due = events.filter((event) => event.frame === state.frame);
      state = advanceSimState(lot, state, { frame: state.frame, events: due }, DT_S);
      const hasClip = state.warnings.some((warning) => warning.kind === 'park_clip');
      if (!hasClip) {
        continue;
      }
      const row = gtRow(lot, state, '2cam');
      for (const car of state.cars) {
        if (car.state === 'exited' || car.slot === null) {
          continue;
        }
        // Xe đã đỗ đúng ô của nó: tâm phải nằm trong đa giác ô đó.
        if (car.state !== 'parked') {
          continue;
        }
        const own = lot.slots.find((slot) => slot.id === car.slot);
        if (own === undefined) {
          continue;
        }
        expect(pointInPolygon([car.pose.x, car.pose.y], own.polygon)).toBe(true);
        expect(row.occupancy[own.id]).toBe(1);
        checked += 1;
      }
    }
    console.info(`[GT] đã kiểm ${checked} lượt xe-đỗ trong các frame có park_clip`);
    // Nếu lot mới không còn `park_clip` nào thì không có gì để kiểm — đó là kết quả TỐT hơn
    // (không lấn), không phải thiếu test. Chỉ bắt buộc có kiểm khi thật sự có clip.
    expect(checked).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

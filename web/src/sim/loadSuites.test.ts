/**
 * Bộ tải A/B/C (`tools/gen_load_suites.py`): chạy hết từng kịch bản trên engine thật và kiểm
 *
 * - 0 va chạm ngoài `park_clip`;
 * - không xe kẹt giữa chừng, không xe bỏ hàng chờ, không xe còn kẹt ở frame cuối;
 * - mọi `add_car` được nhận (không bị từ chối vì hết ô / không đường).
 *
 * Đồng thời ghi dòng thời gian thật của từng xe ra `sim3d/tools/out/load_timeline/<id>.json`
 * để `tools/gen_load_doc.py` viết tài liệu thiết kế.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { CarStateName, SimState, Warning } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { advanceSimState, createSimState } from './engine';
import { DT_S } from './constants';
import { countHarshBrakes } from './segments';
import { describeStalls, findStalls, findStillAtEnd } from './stallCheck';
import { describeQueue, findAbandonedQueue } from './stallCheck';

const lot = lotJson as unknown as LotMap;
const TEMPLATES = resolve(__dirname, '../../../data/templates');
const OUT = resolve(__dirname, '../../../tools/out/load_timeline');
const SUITE_RE = /^[ABC]\d_.*\.sim3d\.json$/;

interface CarLine {
  id: string;
  model: string;
  color: string;
  slot: string | null;
  initial: boolean;
  first: Partial<Record<CarStateName, number>>;
}

function run(file: string) {
  const template = JSON.parse(readFileSync(join(TEMPLATES, file), 'utf-8')) as Scenario & {
    events: SimEvent[];
    name: string;
    description: string;
  };
  const scenario = { ...template, lot: lot.name };
  const frames = template.duration_frames;
  let state = createSimState(lot, scenario);
  const initialIds = new Set(state.cars.map((car) => car.id));
  const history: SimState[] = [state];
  const lines = new Map<string, CarLine>();
  const otherWarnings: { carId: string | null; text: string }[] = [];
  const collisions: unknown[] = [];
  const ghostPasses: Warning[] = [];
  const note = (s: SimState) => {
    for (const car of s.cars) {
      let line = lines.get(car.id);
      if (line === undefined) {
        line = {
          id: car.id,
          model: car.model,
          color: car.color,
          slot: car.slot ?? null,
          initial: initialIds.has(car.id),
          first: {},
        };
        lines.set(car.id, line);
      }
      if (car.slot) line.slot = car.slot;
      if (line.first[car.state] === undefined) line.first[car.state] = s.frame;
    }
  };
  note(state);
  for (let frame = 0; frame < frames; frame += 1) {
    const due = template.events.filter((event) => event.frame === state.frame);
    state = advanceSimState(lot, state, { frame: state.frame, events: due }, DT_S);
    history.push(state);
    note(state);
    for (const warning of state.warnings) {
      if (warning.kind === 'collision') collisions.push(warning);
      else if (warning.kind === 'ghost_pass') ghostPasses.push(warning);
      else if (warning.kind !== 'park_clip' && warning.kind !== 'park_clip_escalated') {
        // Lưu `car_id` **có cấu trúc** để lọc theo xe đã lách mà không phải parse lại chuỗi JSON
        // (chuỗi đã bị escape nên regex dễ sai).
        otherWarnings.push({
          carId: typeof warning.car_id === 'string' ? warning.car_id : null,
          text: `${String(state.frame)}:${JSON.stringify(warning)}`,
        });
      }
    }
  }
  const id = file.replace('.sim3d.json', '');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, `${id}.json`),
    JSON.stringify(
      {
        id,
        name: template.name,
        description: template.description,
        fps: 25,
        duration_frames: frames,
        env: template.env,
        noise: template.noise,
        n_initial: initialIds.size,
        cars: [...lines.values()],
        warnings: otherWarnings.map((item) => item.text),
        ghost_passes: ghostPasses,
      },
      null,
      1,
    ),
  );
  return { history, collisions, ghostPasses, otherWarnings, lines };
}

const files = readdirSync(TEMPLATES).filter((name) => SUITE_RE.test(name)).sort();

describe('bộ tải A/B/C chạy sạch trên engine', () => {
  it('có kịch bản tải để chạy', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(file, { timeout: 300_000 }, () => {
      const { history, collisions, ghostPasses, otherWarnings } = run(file);
      const stalls = findStalls(history);
      const still = findStillAtEnd(history);
      const abandoned = findAbandonedQueue(history);
      // P17e: số lần lách + độ chồng lấn max (đo trên mọi cảnh báo ghost_pass).
      const ghostDepthMax = ghostPasses.reduce((max, warning) => {
        const match = /chồng ([\d.]+) m/.exec(warning.message);
        const value = match === null ? 0 : Number(match[1]);
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, 0);
      const ghostCarIds = new Set(
        ghostPasses
          .map((warning) => warning.car_id)
          .filter((id): id is string => typeof id === 'string'),
      );
      // ANS_37 mục 6: số lần phanh gấp (giảm tốc > 2·b_comf) trên mọi xe, ghi số (không chặn).
      const speedsByCar = new Map<string, number[]>();
      for (const snapshot of history) {
        for (const car of snapshot.cars) {
          if (car.state === 'parked' || car.state === 'queued' || car.state === 'exited') {
            continue;
          }
          const list = speedsByCar.get(car.id) ?? [];
          list.push(Math.max(0, car.v));
          speedsByCar.set(car.id, list);
        }
      }
      let harshBrakes = 0;
      for (const speeds of speedsByCar.values()) {
        harshBrakes += countHarshBrakes(speeds, DT_S);
      }
      console.info(
        `[${file}] harshBrakes=${String(harshBrakes)} cars=${String(history[history.length - 1].cars.length)} ` +
          `collisions=${String(collisions.length)} warnings=${String(otherWarnings.length)} ` +
          `stalls=${String(stalls.length)} stillEnd=${String(still.length)} abandoned=${String(abandoned.length)} ` +
          `ghost=${String(ghostCarIds.size)} ghostDepthMax=${ghostDepthMax.toFixed(3)}`,
      );
      if (otherWarnings.length > 0) {
        console.info(otherWarnings.slice(0, 5).map((item) => item.text).join('\n'));
      }
      expect(collisions).toEqual([]);
      // ANS_36: cấm lách — ghost_pass tắt mặc định, nên phải 0 xe lách.
      expect(ghostCarIds.size, `xe lách: ${[...ghostCarIds].join(',')}`).toBe(0);
      expect(stalls, describeStalls(stalls)).toEqual([]);
      expect(still).toEqual([]);
      expect(abandoned, describeQueue(abandoned)).toEqual([]);
      // P17e: `backoff_failed`/`backoff` của xe **đã từng lách** không còn là "kẹt không ai gỡ"
      // nữa — nó đã được gỡ bằng `ghost_pass`. Giữ lại chỉ làm nhiễu báo cáo; điều kiện đúng là
      // "không còn cảnh báo kẹt nào cho xe KHÔNG được gỡ".
      const residualWarnings = otherWarnings.filter((item) => {
        // `lùi ... (backoff)` là **lùi nhường thành công**, không phải kẹt. Nó dùng `kind: 'stuck'`
        // chỉ vì mọi chẩn đoán của engine gom chung một kênh; tính nó là lỗi là phân loại sai.
        if (item.text.includes('(backoff)')) {
          return false;
        }
        // Quyết định director (P17): `backoff_failed` mà xe vẫn đi tiếp là cảnh báo thông tin, không
        // phải lỗi. Điều kiện "xe vẫn đi tiếp" đã được khẳng định ở trên (stalls/still/abandoned
        // đều rỗng), nên ở đây chỉ đếm và in, không tính là residual.
        if (item.text.includes('(backoff_failed)')) {
          return false;
        }
        return true;
      });
      const backoffFailed = otherWarnings.filter((item) =>
        item.text.includes('(backoff_failed)'),
      ).length;
      console.info(`[${file}] backoff_failed (thông tin, không lỗi)=${String(backoffFailed)}`);
      expect(residualWarnings.map((item) => item.text)).toEqual([]);
    });
  }
});

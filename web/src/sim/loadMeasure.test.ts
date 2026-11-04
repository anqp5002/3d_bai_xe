/**
 * P17i — đo một thư mục kịch bản tải (không dùng trong CI: chỉ chạy khi có `LOAD_DIR`).
 *
 *   LOAD_DIR=<thư mục chứa *.sim3d.json> npx vitest run src/sim/loadMeasure.test.ts
 *
 * Ghi `<LOAD_DIR>/measure.json`: mỗi kịch bản có số xe lách, chồng max, va chạm, kẹt, xe chưa xong.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { advanceSimState, createSimState } from './engine';
import { DT_S } from './constants';
import { findAbandonedQueue, findStalls, findStillAtEnd } from './stallCheck';

const lot = lotJson as unknown as LotMap;
const DIR = process.env.LOAD_DIR === undefined ? undefined : resolve(process.env.LOAD_DIR);
const ONLY = process.env.LOAD_ONLY?.split(',').filter((x) => x.length > 0);

const files =
  DIR === undefined
    ? []
    : readdirSync(DIR).filter(
        (name) =>
          name.endsWith('.sim3d.json') && (ONLY === undefined || ONLY.some((id) => name.startsWith(id))),
      );

it.skipIf(DIR === undefined)('đo tải', { timeout: 3_000_000 }, () => {
  const result: Record<string, unknown> = {};
  for (const file of files) {
    const template = JSON.parse(readFileSync(join(DIR as string, file), 'utf-8')) as Scenario & {
      events: SimEvent[];
    };
    let state = createSimState(lot, { ...template, lot: lot.name });
    const history = [state];
    let collisions = 0;
    const ghostCars = new Set<string>();
    let depthMax = 0;
    for (let frame = 0; frame < template.duration_frames; frame += 1) {
      const due = template.events.filter((event) => event.frame === state.frame);
      state = advanceSimState(lot, state, { frame: state.frame, events: due }, DT_S);
      history.push(state);
      for (const warning of state.warnings) {
        if (warning.kind === 'collision') collisions += 1;
        if (warning.kind === 'ghost_pass') {
          if (typeof warning.car_id === 'string') ghostCars.add(warning.car_id);
          const match = /chồng ([\d.]+) m/.exec(warning.message);
          if (match !== null) depthMax = Math.max(depthMax, Number(match[1]));
        }
      }
    }
    const last = history[history.length - 1];
    const unfinished = last.cars.filter(
      (car) => car.state !== 'parked' && car.state !== 'exited',
    ).length;
    result[file.replace('.sim3d.json', '')] = {
      cars: last.cars.length,
      duration_s: template.duration_frames / 25,
      collisions,
      ghost_cars: ghostCars.size,
      ghost_depth_max: Math.round(depthMax * 1000) / 1000,
      stalls: findStalls(history).length,
      still_end: findStillAtEnd(history).length,
      abandoned: findAbandonedQueue(history).length,
      unfinished,
    };
    writeFileSync(join(DIR as string, 'measure.json'), JSON.stringify(result, null, 1));
  }
});

/**
 * P17n — GT tính theo luồng phải **giống từng byte** bản cũ quét toàn history.
 *
 * Bản tham chiếu = code cũ nguyên văn (`gtReference.ts`, `export/gtGateIdealReference.ts`, và vòng
 * gộp `ghost_pass` cũ của `runExport`). Chạy trên K1–K8 + A1 + B1 (xe đỗ sẵn, vào/ra liên tục) bằng
 * đường chạy thật của engine.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { SimState } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { advanceSimState, createSimState } from './engine';
import { DT_S } from './constants';
import {
  GtEventsStream,
  GtFramesStream,
  gtEvents,
  gtEventsCsv,
  gtFramesCsv,
  gtRow,
  collectCarIds,
} from './gtCompute';
import {
  collectCarIds as collectCarIdsRef,
  gtEvents as gtEventsRef,
  gtEventsCsv as gtEventsCsvRef,
  gtFramesCsv as gtFramesCsvRef,
  gtRow as gtRowRef,
} from './gtReference';
import { GateIdealStream, gtGateIdeal, gtGateIdealCsv } from '../export/gtGateIdeal';
import {
  gtGateIdeal as gtGateIdealRef,
  gtGateIdealCsv as gtGateIdealCsvRef,
} from '../export/gtGateIdealReference';
import { GhostPassAccumulator, ParkClipLog } from '../export/runLog';
import { buildCountLines, lotWithCountLines } from '../export/countLines';

import k1 from '../../../data/templates/K1.sim3d.json';
import k2 from '../../../data/templates/K2.sim3d.json';
import k3 from '../../../data/templates/K3.sim3d.json';
import k4 from '../../../data/templates/K4.sim3d.json';
import k5 from '../../../data/templates/K5.sim3d.json';
import k6 from '../../../data/templates/K6.sim3d.json';
import k7 from '../../../data/templates/K7.sim3d.json';
import k8 from '../../../data/templates/K8.sim3d.json';
import a1 from '../../../data/templates/A1_vao_deu_30.sim3d.json';
import b1 from '../../../data/templates/B1_quay_vong_vua.sim3d.json';

const lot = lotJson as unknown as LotMap;

interface Template {
  readonly events: readonly SimEvent[];
  readonly duration_frames: number;
}

function run(template: unknown, maxFrames: number): SimState[] {
  const scenario = { ...(template as Scenario), lot: lot.name } as Scenario & Template;
  const frames = Math.min(scenario.duration_frames, maxFrames);
  const byFrame = new Map<number, SimEvent[]>();
  for (const event of scenario.events) {
    const list = byFrame.get(event.frame) ?? [];
    list.push(event);
    byFrame.set(event.frame, list);
  }
  let state = createSimState(lot, scenario);
  const history: SimState[] = [state];
  for (let index = 1; index < frames; index += 1) {
    state = advanceSimState(
      lot,
      state,
      { frame: state.frame, events: byFrame.get(state.frame) ?? [] },
      DT_S,
    );
    history.push(state);
  }
  return history;
}

/** Vòng gộp ghost_pass cũ của `runExport` (nguyên văn, chạy trên cả history). */
function ghostPassesReference(history: readonly SimState[]) {
  const out: unknown[] = [];
  const open = new Map<string, { start: number; end: number; through: Set<string>; depth: number }>();
  for (const state of history) {
    const seen = new Set<string>();
    for (const warning of state.warnings) {
      if (warning.kind !== 'ghost_pass' || typeof warning.car_id !== 'string') {
        continue;
      }
      const carId = warning.car_id;
      seen.add(carId);
      const match = /chồng ([\d.]+) m/.exec(warning.message);
      const depth = match === null ? 0 : Number(match[1]);
      const through = /lách qua ([^ ]+)/.exec(warning.message)?.[1] ?? '';
      const current = open.get(carId);
      if (current === undefined) {
        open.set(carId, {
          start: state.frame,
          end: state.frame,
          through: new Set(through === '' ? [] : through.split(',')),
          depth: Number.isFinite(depth) ? depth : 0,
        });
        continue;
      }
      current.end = state.frame;
      for (const id of through === '' ? [] : through.split(',')) {
        current.through.add(id);
      }
      if (Number.isFinite(depth)) {
        current.depth = Math.max(current.depth, depth);
      }
    }
    for (const [carId, value] of [...open.entries()]) {
      if (seen.has(carId)) {
        continue;
      }
      out.push({
        car_id: carId,
        start_frame: value.start,
        end_frame: value.end,
        through: [...value.through].sort(),
        depth_max_m: Number(value.depth.toFixed(3)),
      });
      open.delete(carId);
    }
  }
  for (const [carId, value] of open.entries()) {
    out.push({
      car_id: carId,
      start_frame: value.start,
      end_frame: value.end,
      through: [...value.through].sort(),
      depth_max_m: Number(value.depth.toFixed(3)),
    });
  }
  return out;
}

const CASES: ReadonlyArray<readonly [string, unknown, number]> = [
  ['K1', k1, 4000],
  ['K2', k2, 4000],
  ['K3', k3, 4000],
  ['K4', k4, 4000],
  ['K5', k5, 7000],
  ['K6', k6, 4000],
  ['K7', k7, 4000],
  ['K8', k8, 4000],
  ['A1', a1, 4000],
  ['B1', b1, 5000],
];

describe('GT tính theo luồng == bản cũ quét toàn history (P17n)', () => {
  for (const [name, template, maxFrames] of CASES) {
    it(
      `${name}: gt_frames, gt_events, gt_gate_ideal, ghost_pass, park_clip giống từng byte`,
      { timeout: 300_000 },
      () => {
        const history = run(template, maxFrames);
        const mode = (template as Scenario).camera_mode;

        // gt_frames.csv
        const carIdsRef = collectCarIdsRef(history);
        const refFrames = gtFramesCsvRef(
          history.map((state) => gtRowRef(lot, state, mode)),
          carIdsRef,
        );
        const framesStream = new GtFramesStream(lot, mode);
        for (const state of history) {
          framesStream.push(state);
        }
        expect(framesStream.carIds).toEqual(carIdsRef);
        expect(framesStream.finish()).toBe(refFrames);
        // bản dùng chung cũng giữ nguyên
        expect(collectCarIds(history)).toEqual(carIdsRef);
        expect(gtFramesCsv(history.map((state) => gtRow(lot, state, mode)), carIdsRef)).toBe(refFrames);

        // gt_events.csv (dùng lot có vạch đếm như runExport; thử cả có/không gateNotes)
        const countLines = buildCountLines(lot);
        const eventsLot = lotWithCountLines(lot, countLines);
        const notes = new Map([['S048', 'test']] as const) as unknown as ReadonlyMap<string, never>;
        for (const gateNotes of [undefined, notes]) {
          const refEvents = gtEventsCsvRef([...gtEventsRef(eventsLot, history, gateNotes)]);
          const eventStream = new GtEventsStream(eventsLot);
          for (const state of history) {
            eventStream.push(state);
          }
          expect(gtEventsCsv([...eventStream.finish(gateNotes)])).toBe(refEvents);
          expect(gtEventsCsv([...gtEvents(eventsLot, history, gateNotes)])).toBe(refEvents);
        }

        // gt_gate_ideal.csv
        const refIdeal = gtGateIdealCsvRef(gtGateIdealRef(lot, history));
        const idealStream = new GateIdealStream(lot);
        for (const state of history) {
          idealStream.push(state);
        }
        expect(gtGateIdealCsv(idealStream.rows)).toBe(refIdeal);
        expect(gtGateIdealCsv(gtGateIdeal(lot, history))).toBe(refIdeal);

        // ghost_pass + park_clip
        const ghost = new GhostPassAccumulator();
        const clip = new ParkClipLog();
        for (const state of history) {
          ghost.push(state);
          clip.push(state);
        }
        expect(ghost.snapshot()).toEqual(ghostPassesReference(history));
        expect(clip.parkClip).toEqual(
          history.flatMap((state) => state.warnings.filter((warning) => warning.kind === 'park_clip')),
        );
        expect(clip.escalated).toEqual(
          history.flatMap((state) =>
            state.warnings.filter((warning) => warning.kind === 'park_clip_escalated'),
          ),
        );
      },
    );
  }

  it('history rỗng: không dòng nào', () => {
    expect(gtEvents(lot, [])).toEqual([]);
    expect(gtGateIdeal(lot, [])).toEqual([]);
  });
});

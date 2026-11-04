/**
 * P17n — đo RAM khi chạy dài (không chạy trong CI: cần `LONGRUN=live|export|old`).
 *
 *   NODE_OPTIONS=--expose-gc LONGRUN=live LONGRUN_FILE=<kịch bản> npx vitest run src/store/longRun.test.ts
 *
 * - `live`: giống `stepFrames` mới (đuôi history 600 + tóm tắt cảnh báo tăng dần).
 * - `export`: giống `runExport` mới (chỉ state hiện tại + các bộ tích luỹ GT theo luồng).
 * - `old`: hành vi cũ (`history = [...history, state]`), dừng ở 22.500 frame (15 phút).
 * Ghi `sim3d/tools/out/p17n/mem_<mode>.json`: heapUsed (MB, sau gc) ở các mốc 5/10/15/30/60 phút.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { SimState } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { advanceSimState, createSimState } from '../sim/engine';
import { DT_S } from '../sim/constants';
import { GtEventsStream, GtFramesStream } from '../sim/gtCompute';
import { GateIdealStream } from '../export/gtGateIdeal';
import { GhostPassAccumulator, ParkClipLog } from '../export/runLog';
import { appendHistoryTail, newRunLog } from './simStore';

const mode = process.env.LONGRUN;
const FPS = 25;
const MARKS_MIN = [1, 5, 10, 15, 30, 45, 60];

function heapMb(): number {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (gc !== undefined) {
    gc();
  }
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

it.skipIf(mode === undefined)('đo RAM chạy dài', { timeout: 6 * 3600_000 }, () => {
  const file = resolve(process.env.LONGRUN_FILE ?? '../tools/out/p17n/LONG60.sim3d.json');
  const template = JSON.parse(readFileSync(file, 'utf-8')) as Scenario & { events: SimEvent[] };
  const lot = lotJson as unknown as LotMap;
  const byFrame = new Map<number, SimEvent[]>();
  for (const event of template.events) {
    byFrame.set(event.frame, [...(byFrame.get(event.frame) ?? []), event]);
  }
  const total = mode === 'old' ? 15 * 60 * FPS : template.duration_frames;
  let state = createSimState(lot, { ...template, lot: lot.name });

  let history: readonly SimState[] = [state];
  let oldHistory: SimState[] = [state];
  const runLog = newRunLog();
  const frames = new GtFramesStream(lot, template.camera_mode);
  const events = new GtEventsStream(lot);
  const ideal = new GateIdealStream(lot);
  const ghost = new GhostPassAccumulator();
  const clip = new ParkClipLog();

  const marks = new Map(MARKS_MIN.map((minute) => [minute * 60 * FPS, minute]));
  const rows: Array<Record<string, number>> = [];
  const t0 = Date.now();
  for (let frame = 1; frame < total; frame += 1) {
    state = advanceSimState(lot, state, { frame: state.frame, events: byFrame.get(state.frame) ?? [] }, DT_S);
    if (mode === 'live') {
      history = appendHistoryTail(history, [state]);
      runLog.ghost.push(state);
      runLog.parkClip.push(state);
    } else if (mode === 'old') {
      oldHistory = [...oldHistory, state];
    } else if (mode === 'export') {
      frames.push(state);
      events.push(state);
      ideal.push(state);
      ghost.push(state);
      clip.push(state);
    }
    const minute = marks.get(frame);
    if (minute !== undefined) {
      rows.push({ minute, frame, heap_mb: heapMb(), elapsed_s: Math.round((Date.now() - t0) / 1000) });
      mkdirSync(resolve('../tools/out/p17n'), { recursive: true });
      writeFileSync(resolve(`../tools/out/p17n/mem_${String(mode)}.json`), JSON.stringify(rows, null, 1));
    }
  }
  if (mode === 'export') {
    const csv = frames.finish();
    rows.push({ minute: -1, frame: total, heap_mb: heapMb(), elapsed_s: Math.round((Date.now() - t0) / 1000), gt_frames_csv_mb: Math.round(csv.length / 1024 / 1024) });
    events.finish();
  }
  writeFileSync(resolve(`../tools/out/p17n/mem_${String(mode)}.json`), JSON.stringify(rows, null, 1));
});

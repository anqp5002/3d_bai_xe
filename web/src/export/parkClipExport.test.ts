/**
 * Test P7d: `park_clip` trong `export_log` + chuỗi lệnh README (mục 2, 3).
 *
 * Không cần WebGL/WebCodecs: dùng renderer/encoder/backend giả như `runExport.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimState, Warning } from '../contracts/sim';
import type { VerifyReport } from '../api/client';
import {
  outputSizesAt,
  runExport,
  type ExportBackend,
  type ExportOutput,
  type FrameEncoder,
  type FrameRenderer,
  type FrameSurface,
} from './runExport';
import { TECHGAR_SCALE } from './techgarConfig';
import { buildReadme } from './techgarBundle';

const LOT: LotMap = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'data', 'lot', 'lot_pucpr.json'), 'utf8'),
) as LotMap;

function makeScenario(cameraMode: '1cam' | '2cam' = '2cam', frames = 8): Scenario {
  return {
    schema: 1,
    lot: 'pucpr',
    seed: 7,
    car_scale: 1.1,
    default_speed_kmh: 10,
    camera_mode: cameraMode,
    initial: { n_parked: 0, placement: [] },
    env: { preset: 'E1', keyframes: [{ t_s: 0, hour: 12, weather: 'sun', intensity: 0.8 }] },
    noise: {
      shake: { on: false, level: 0.5 },
      grain: { on: false, level: 0.5 },
      jpeg: { on: false, level: 0.5 },
      downscale: { on: false, level: 0.5 },
      fps_drop: { on: false, level: 0.5 },
      flare: { on: false, level: 0.5 },
      drops: { on: false, level: 0.5 },
      smudge: { on: false, level: 0.5 },
      white_balance: { on: false, level: 0.5 },
      seed: 7,
    },
    events: [],
    duration_frames: frames,
  };
}

/** Một `park_clip` hợp lệ (đủ trường `sim/parkClip` cần để gộp đợt). */
function clipWarning(frame: number, depth: number, slot = 'S001', neighbour = 'S002'): Warning {
  return {
    frame,
    kind: 'park_clip',
    message: `V001 lấn ${depth.toFixed(3)} m vào ${neighbour}`,
    car_id: 'V001',
    slot: slot as Warning['slot'],
    neighbour_slot: neighbour as Warning['neighbour_slot'],
    neighbour_car_id: 'V002',
    depth_m: depth,
  };
}

/** Một `park_clip_escalated` (ANS_13) — cùng trường, chỉ khác `kind` + trần 0,35 m. */
function escalatedWarning(frame: number, depth: number, slot = 'S001', neighbour = 'S002'): Warning {
  return {
    ...clipWarning(frame, depth, slot, neighbour),
    kind: 'park_clip_escalated',
    message: `V001 lấn ${depth.toFixed(3)} m vào ${neighbour} (LEO THANG ANS_13)`,
  };
}

function makeState(frame: number, warnings: readonly Warning[]): SimState {
  return {
    frame,
    cars: [],
    reservations: [],
    rngState: { placement: 1, color: 2, model: 3, slot: 4, noise: 5, misc: 6 },
    warnings,
  };
}

function makeSim(scenario: Scenario, frames: number, clipFrames: readonly number[], depth = 0.12) {
  const states = Array.from({ length: frames }, (_, frame) =>
    makeState(
      frame,
      clipFrames.includes(frame) ? [clipWarning(frame, depth)] : [],
    ),
  );
  return {
    lot: LOT,
    scenario,
    totalFrames: frames,
    at: (frame: number): SimState => states[frame],
    runToEnd: (): readonly SimState[] => states,
  };
}

function makeSurface(width: number, height: number): FrameSurface {
  return { width, height, toPng: () => Promise.resolve(new Uint8Array([1, 2, 3])) };
}

function makeRenderer(): FrameRenderer {
  return {
    render: (_state, outputs) => {
      const surfaces = {} as Record<ExportOutput, FrameSurface>;
      for (const output of outputs) {
        const [width, height] = outputSizesAt(TECHGAR_SCALE)[output];
        surfaces[output] = makeSurface(width, height);
      }
      return surfaces;
    },
  };
}

function makeEncoder(): FrameEncoder {
  return {
    addFrame: () => Promise.resolve(),
    finish: () => Promise.resolve(new Uint8Array([1])),
    abort: () => Promise.resolve(),
  };
}

function makeBackend(): ExportBackend & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const verify: VerifyReport = {
    ok: true,
    run_id: 'run-1',
    generated_at: '2026-11-01T00:00:00Z',
    items: [],
    export_seconds: 1,
    realtime_ratio: 1,
  };
  return {
    files,
    createRun: () => Promise.resolve({ run_id: 'run-1' }),
    putRunFile: (_id, path, body) => {
      // Giữ nội dung để kiểm `export_log.json`.
      const text =
        body instanceof ArrayBuffer ? new TextDecoder().decode(body) : '<blob>';
      files.set(path, text);
      return Promise.resolve();
    },
    postRunFrame: () => Promise.resolve(),
    finalize: () => Promise.resolve(verify),
  };
}

const BASE = {
  name: 'p7d',
  outputs: ['full', 'cam1', 'cam2'] as readonly ExportOutput[],
  scenarioHash: 'sha256:p7d',
  startedAt: '2026-11-01T00:00:00Z',
};

describe('P7d — park_clip trong export_log (ANS_4 mục 4)', () => {
  it('không có park_clip ⇒ episodes rỗng, summary toàn 0', async () => {
    const backend = makeBackend();
    const result = await runExport({
      ...BASE,
      sim: makeSim(makeScenario(), 8, []),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend,
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    expect(result.exportLog.park_clip.episodes).toEqual([]);
    expect(result.exportLog.park_clip.summary.episodes).toBe(0);
    expect(result.exportLog.park_clip.summary.max_depth_m).toBe(0);
    expect(result.exportLog.park_clip.summary.total_frames).toBe(0);
  });

  it('3 frame liền nhau cùng xe+ô ⇒ gộp thành **1 đợt** frame_count 3', async () => {
    const result = await runExport({
      ...BASE,
      sim: makeSim(makeScenario(), 8, [2, 3, 4], 0.11),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    const clip = result.exportLog.park_clip;
    expect(clip.episodes).toHaveLength(1);
    expect(clip.episodes[0].frame_first).toBe(2);
    expect(clip.episodes[0].frame_count).toBe(3);
    expect(clip.episodes[0].frame_last).toBe(4);
    expect(clip.episodes[0].car_id).toBe('V001');
    expect(clip.episodes[0].slot).toBe('S001');
    expect(clip.episodes[0].neighbour_slot).toBe('S002');
    expect(clip.summary.episodes).toBe(1);
    expect(clip.summary.total_frames).toBe(3);
    expect(clip.summary.max_depth_m).toBeCloseTo(0.11, 6);
  });

  it('hai nhóm rời nhau ⇒ 2 đợt, max_depth là sâu nhất', async () => {
    const scenario = makeScenario();
    const states = Array.from({ length: 10 }, (_, frame) =>
      makeState(frame, [
        ...(frame === 0 || frame === 1 ? [clipWarning(frame, 0.05)] : []),
        ...(frame === 5 ? [clipWarning(frame, 0.19)] : []),
      ]),
    );
    const result = await runExport({
      ...BASE,
      sim: {
        lot: LOT,
        scenario,
        totalFrames: 10,
        at: (frame) => states[frame],
        runToEnd: () => states,
      },
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    const clip = result.exportLog.park_clip;
    expect(clip.summary.episodes).toBe(2);
    expect(clip.summary.total_frames).toBe(3);
    expect(clip.summary.max_depth_m).toBeCloseTo(0.19, 6);
    expect(clip.summary.longest_frames).toBe(2);
  });

  it('export_log.json ghi lên BE có `park_clip` (không chỉ trong bộ nhớ)', async () => {
    const backend = makeBackend();
    await runExport({
      ...BASE,
      sim: makeSim(makeScenario(), 6, [1, 2], 0.09),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend,
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    const text = backend.files.get('export_log.json');
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as {
      park_clip: { episodes: { frame_count: number }[]; summary: { episodes: number } };
    };
    expect(parsed.park_clip.summary.episodes).toBe(1);
    expect(parsed.park_clip.episodes[0].frame_count).toBe(2);
  });

  it('park_clip KHÔNG làm verify sai (vẫn ok:true)', async () => {
    const result = await runExport({
      ...BASE,
      sim: makeSim(makeScenario(), 6, [0, 1, 2, 3], 0.14),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    expect(result.verify.ok).toBe(true);
    expect(result.exportLog.park_clip.summary.episodes).toBe(1);
    // Và `warnings` (danh sách cảnh báo text) không bị nhồi park_clip vào.
    expect(result.exportLog.warnings.some((text) => text.includes('park_clip'))).toBe(false);
  });
});

describe('P10e — park_clip_escalated trong export_log (ANS_13 mục 3)', () => {
  it('không có leo thang ⇒ khối escalation toàn 0 (kỳ vọng K2–K8)', async () => {
    const result = await runExport({
      ...BASE,
      sim: makeSim(makeScenario(), 8, []),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    expect(result.exportLog.park_clip_escalated.episodes).toEqual([]);
    expect(result.exportLog.park_clip_escalated.summary.episodes).toBe(0);
    expect(result.exportLog.park_clip_escalated.summary.max_depth_m).toBe(0);
    expect(result.exportLog.park_clip_escalated.summary.total_frames).toBe(0);
  });

  it('leo thang được ghi RIÊNG, không lẫn vào park_clip', async () => {
    const scenario = makeScenario();
    const states = Array.from({ length: 8 }, (_, frame) =>
      makeState(frame, [
        // 2 frame park_clip thường (frame 0–1) + 2 frame leo thang (frame 4–5).
        ...(frame === 0 || frame === 1 ? [clipWarning(frame, 0.12)] : []),
        ...(frame === 4 || frame === 5 ? [escalatedWarning(frame, 0.28)] : []),
      ]),
    );
    const result = await runExport({
      ...BASE,
      sim: {
        lot: LOT,
        scenario,
        totalFrames: 8,
        at: (frame) => states[frame],
        runToEnd: () => states,
      },
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    // park_clip chỉ thấy 2 frame thường.
    expect(result.exportLog.park_clip.summary.episodes).toBe(1);
    expect(result.exportLog.park_clip.summary.total_frames).toBe(2);
    expect(result.exportLog.park_clip.summary.max_depth_m).toBeCloseTo(0.12, 6);
    // escalation riêng, giữ đúng frame + độ sâu.
    const escalated = result.exportLog.park_clip_escalated;
    expect(escalated.summary.episodes).toBe(1);
    expect(escalated.summary.total_frames).toBe(2);
    expect(escalated.summary.max_depth_m).toBeCloseTo(0.28, 6);
    expect(escalated.episodes[0].frame_first).toBe(4);
    expect(escalated.episodes[0].frame_last).toBe(5);
    expect(escalated.episodes[0].car_id).toBe('V001');
    expect(escalated.episodes[0].neighbour_slot).toBe('S002');
  });

  it('leo thang KHÔNG làm verify sai và KHÔNG nhồi vào warnings text', async () => {
    const scenario = makeScenario();
    const states = Array.from({ length: 6 }, (_, frame) =>
      makeState(frame, frame === 2 ? [escalatedWarning(frame, 0.31)] : []),
    );
    const result = await runExport({
      ...BASE,
      sim: {
        lot: LOT,
        scenario,
        totalFrames: 6,
        at: (frame) => states[frame],
        runToEnd: () => states,
      },
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    expect(result.verify.ok).toBe(true);
    expect(result.exportLog.park_clip_escalated.summary.episodes).toBe(1);
    expect(
      result.exportLog.warnings.some((text) => text.includes('park_clip_escalated')),
    ).toBe(false);
  });

  it('export_log.json ghi lên BE có `park_clip_escalated`', async () => {
    const backend = makeBackend();
    const scenario = makeScenario();
    const states = Array.from({ length: 6 }, (_, frame) =>
      makeState(frame, frame === 1 ? [escalatedWarning(frame, 0.3)] : []),
    );
    await runExport({
      ...BASE,
      sim: {
        lot: LOT,
        scenario,
        totalFrames: 6,
        at: (frame) => states[frame],
        runToEnd: () => states,
      },
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend,
      clock: { nowMs: (() => { let t = 0; return () => (t += 10); })() },
      pause: { paused: false, waitIfPaused: () => Promise.resolve(true) },
    });
    const text = backend.files.get('export_log.json');
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as {
      park_clip_escalated: {
        episodes: { frame_count: number; max_depth_m: number }[];
        summary: { episodes: number; max_depth_m: number };
      };
    };
    expect(parsed.park_clip_escalated.summary.episodes).toBe(1);
    expect(parsed.park_clip_escalated.episodes[0].frame_count).toBe(1);
    expect(parsed.park_clip_escalated.summary.max_depth_m).toBeCloseTo(0.3, 6);
  });
});

describe('P7d — README.txt nối dòng bằng backtick (mục 2)', () => {
  /** Nội dung README mẫu (dùng hàm thật, không chép tay). */
  function readmeText(): string {
    return buildReadme({
      runId: 'p7d-test',
      k: 2.06,
      implied: 4.48,
      depthM: 4.85,
      error: 0.075,
      onlyCam1: 37,
      onlyCam2: 30,
      both: 33,
      orphanCount: 0,
      warnings: [],
    });
  }

  it('mọi khối lệnh PowerShell: dòng nối tiếp kết thúc bằng backtick, dòng cuối thì không', () => {
    const lines = readmeText().split('\n');
    let inBlock = false;
    let blockIndex = 0;
    const problems: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim().startsWith('```powershell')) {
        inBlock = true;
        blockIndex += 1;
        continue;
      }
      if (inBlock && line.trim() === '```') {
        inBlock = false;
        continue;
      }
      if (!inBlock) {
        continue;
      }
      // Dòng trống **ngăn cách khối khai báo và khối lệnh** là hợp lệ (PowerShell cho phép);
      // dòng trống **giữa** một lệnh nối tiếp mới là lỗi. Phát hiện: dòng trước và dòng sau
      // đều là tham số `--x` ⇒ trống ở giữa = lỗi; còn lại thì bỏ qua.
      if (line.trim().length === 0) {
        const prevIsParam = index > 0 && /^\s{2,}--/.test(lines[index - 1]);
        const nextIsParam = index + 1 < lines.length && /^\s{2,}--/.test(lines[index + 1]);
        if (prevIsParam && nextIsParam) {
          problems.push(`khối ${blockIndex} dòng ${index + 1}: dòng trống giữa lệnh nối tiếp`);
        }
        continue;
      }
      // Dòng **bắt đầu** một lệnh (không thụt lề) mà dòng sau là tham số ⇒ phải có backtick.
      const startsCommand = !/^\s/.test(line);
      const nextIsContinuation =
        index + 1 < lines.length && /^\s{2,}--/.test(lines[index + 1]);
      if (startsCommand && nextIsContinuation && !line.trimEnd().endsWith('`')) {
        problems.push(`khối ${blockIndex} dòng ${index + 1}: thiếu backtick nối: ${line.trim()}`);
      }
      // Dòng tham số `--x` mà dòng sau còn tham số nữa ⇒ cũng phải có backtick.
      const isParam = /^\s{2,}--/.test(line);
      const nextIsParam = index + 1 < lines.length && /^\s{2,}--/.test(lines[index + 1]);
      if (isParam && nextIsParam && !line.trimEnd().endsWith('`')) {
        problems.push(
          `khối ${blockIndex} dòng ${index + 1}: tham số thiếu backtick: ${line.trim()}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('Bước 2 (`--gate-config`) kết thúc bằng backtick như Bước 1', () => {
    const lines = readmeText().split('\n');
    // Chỉ lấy dòng **trong khối lệnh** (bắt đầu bằng 2 space + `--gate-config`), không lấy
    // chỗ văn xuôi có nhắc tới cờ này.
    const inCommand = lines.filter((line) => /^\s{2,}--gate-config/.test(line));
    expect(inCommand).toHaveLength(1);
    expect(inCommand[0].trimEnd().endsWith('`')).toBe(true);
    // Và dòng sau nó còn là tham số (`--port`), nên backtick là **bắt buộc**.
    const idx = lines.indexOf(inCommand[0]);
    expect(lines[idx + 1]).toContain('--port');
  });

  it('không còn template literal lọt vào README (mọi dòng đều là chuỗi)', () => {
    const text = readmeText();
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('[object Object]');
    // Ba khoá bắt buộc của TechGAR phải có trong lệnh.
    for (const token of [
      '--calibration',
      '--slots-cam1',
      '--slots-cam2',
      '--mask-cam1',
      '--mask-cam2',
      '--detector-profile',
      '--live-mode',
      '--gate-config',
    ]) {
      expect(text).toContain(token);
    }
  });
});

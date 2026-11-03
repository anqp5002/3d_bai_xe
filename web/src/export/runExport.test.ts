/**
 * Test vòng xuất offline với **renderer/encoder/backend giả** (P7a mục 4).
 *
 * Không cần WebGL, WebCodecs, DOM, mạng: mọi phụ thuộc đều tiêm vào. Kiểm đúng những
 * điều D12/FE §7 bắt buộc: số frame, tạm dừng khi tab ẩn, huỷ khi encoder lỗi, không
 * nuốt lỗi, `history` đủ frame.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { SimState } from '../contracts/sim';
import type { VerifyReport } from '../api/client';
import {
  EXPORT_OUTPUTS,
  ExportError,
  OUTPUT_SIZES,
  outputSizesAt,
  fileNameFor,
  realtimeRatio,
  renderFps,
  runExport,
  syncLeaderFrames,
  validateOutputs,
  type ExportBackend,
  type ExportOutput,
  type FrameEncoder,
  type FrameRenderer,
  type FrameSurface,
  type PauseGate,
  type SimSource,
} from './runExport';
import { TECHGAR_SCALE } from './techgarConfig';

const LOT: LotMap = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'data', 'lot', 'lot_pucpr.json'), 'utf8'),
) as LotMap;

/** Kịch bản tối thiểu: 2 cam, 10 frame, 2 xe đỗ sẵn ở 2 ô đầu. */
function makeScenario(cameraMode: '1cam' | '2cam' = '2cam', durationFrames = 10): Scenario {
  return {
    schema: 1,
    lot: 'pucpr',
    seed: 7,
    car_scale: 1.1,
    default_speed_kmh: 10,
    camera_mode: cameraMode,
    initial: {
      n_parked: 2,
      placement: [
        { slot: LOT.slots[0].id, car_id: 'V001', model: 'sedan', color: 'red' },
        { slot: LOT.slots[1].id, car_id: 'V002', model: 'suv', color: 'blue' },
      ],
    },
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
    duration_frames: durationFrames,
  };
}

/** State giả: đủ trường `SimState` để `gtRow`/`gtEvents` chạy. */
function makeState(frame: number, scenario: Scenario): SimState {
  const cars = scenario.initial.placement.map((entry) => {
    const slot = LOT.slots.find((candidate) => candidate.id === entry.slot);
    if (slot === undefined) {
      throw new Error('fixture sai: không có ô');
    }
    return {
      id: entry.car_id,
      model: entry.model,
      color: entry.color,
      length: 4.6,
      width: 1.8,
      scale: 1.1,
      pose: { x: slot.center[0], y: slot.center[1], th: slot.heading },
      v: 0,
      state: 'parked' as const,
      slot: slot.id,
    };
  });
  return {
    frame,
    cars,
    reservations: [],
    rngState: { placement: 1, color: 2, model: 3, slot: 4, noise: 5, misc: 6 },
    warnings: [],
  };
}

/** Nguồn mô phỏng giả: `at()` trả state theo frame, `runToEnd()` trả đủ history. */
function makeSim(scenario: Scenario, frames: number): SimSource {
  return {
    lot: LOT,
    scenario,
    totalFrames: frames,
    at: (frame) => makeState(frame, scenario),
    runToEnd: () => Array.from({ length: frames }, (_, frame) => makeState(frame, scenario)),
  };
}

/** Bề mặt giả: đúng kích thước yêu cầu, `toPng` trả byte giả. */
function makeSurface(width: number, height: number): FrameSurface {
  return {
    width,
    height,
    toPng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47, width & 0xff, height & 0xff])),
  };
}

/** Renderer giả: ghi lại số lần gọi + frame đã render. */
function makeRenderer(track?: { frames: number[] }): FrameRenderer {
  return {
    render: (state, outputs) => {
      track?.frames.push(state.frame);
      const surfaces = {} as Record<ExportOutput, FrameSurface>;
      for (const output of outputs) {
        const [width, height] = outputSizesAt(TECHGAR_SCALE)[output];
        surfaces[output] = makeSurface(width, height);
      }
      return surfaces;
    },
  };
}

/** Encoder giả: đếm frame, trả byte khi `finish`. */
function makeEncoder(options: {
  failAt?: number;
  records?: { frames: number[] };
} = {}): FrameEncoder {
  let index = 0;
  return {
    addFrame: (frame) => {
      if (options.failAt !== undefined && index === options.failAt) {
        return Promise.reject(new Error(`encoder nổ ở frame ${String(frame)}`));
      }
      index += 1;
      options.records?.frames.push(frame);
      return Promise.resolve();
    },
    finish: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    abort: () => Promise.resolve(),
  };
}

/** Backend giả: ghi lại mọi file PUT + finalize. */
function makeBackend(verifyOk = true): ExportBackend & {
  files: Map<string, number>;
  frames: number[];
} {
  const files = new Map<string, number>();
  const frames: number[] = [];
  const verify: VerifyReport = {
    ok: verifyOk,
    run_id: 'run-1',
    generated_at: '2026-10-31T05:00:00Z',
    items: [],
    export_seconds: 1,
    realtime_ratio: 1,
  };
  return {
    files,
    frames,
    createRun: () => Promise.resolve({ run_id: 'run-1' }),
    putRunFile: (id, path) => {
      files.set(`${id}/${path}`, (files.get(`${id}/${path}`) ?? 0) + 1);
      return Promise.resolve();
    },
    postRunFrame: (_id, frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    finalize: () => Promise.resolve(verify),
  };
}

/** Cổng tạm dừng giả: cho phép bật/tắt + huỷ. */
function makePause(): PauseGate & { setPaused(value: boolean): void; cancel(): void } {
  let paused = false;
  let cancelled = false;
  return {
    get paused() {
      return paused;
    },
    setPaused: (value) => {
      paused = value;
    },
    cancel: () => {
      cancelled = true;
    },
    waitIfPaused: () => {
      if (cancelled) {
        return Promise.resolve(false);
      }
      // Trong test, tạm dừng không chặn thật: bỏ qua để test không treo.
      return Promise.resolve(true);
    },
  };
}

/** Đồng hồ giả: mỗi lần `nowMs()` tăng 10 ms. */
function makeClock(stepMs = 10): { nowMs(): number } {
  let now = 1_000;
  return {
    nowMs: () => {
      now += stepMs;
      return now;
    },
  };
}

const BASE_OPTIONS = {
  name: 'test-run',
  outputs: ['full', 'cam1', 'cam2'] as readonly ExportOutput[],
  scenarioHash: 'sha256:deadbeef',
  startedAt: '2026-10-31T05:00:00Z',
};

describe('export/runExport — kiểm tham số', () => {
  it('outputs rỗng / lạ / trùng đều ném ExportError(config)', () => {
    expect(() => validateOutputs([])).toThrow(/rỗng/);
    expect(() => validateOutputs(['full', 'full'])).toThrow(/trùng/);
    expect(() => validateOutputs(['nope' as ExportOutput])).toThrow(/giá trị lạ/);
  });

  it('tên file MP4 giữ đúng tên bộ cũ (BE §2)', () => {
    expect(fileNameFor('full')).toBe('raw_full.mp4');
    expect(fileNameFor('cam1')).toBe('raw_cam1.mp4');
    expect(fileNameFor('cam2')).toBe('raw_cam2.mp4');
  });

  it('kích thước đầu ra đúng BE §4.2', () => {
    expect(OUTPUT_SIZES.full).toEqual([640, 640]);
    expect(OUTPUT_SIZES.cam1).toEqual([400, 640]);
    expect(OUTPUT_SIZES.cam2).toEqual([400, 640]);
  });

  it('tỉ lệ thời gian thực và fps render đúng công thức', () => {
    // 25 frame = 1 s video; 500 ms tường ⇒ 2× thời gian thực.
    expect(realtimeRatio(25, 500)).toBeCloseTo(2, 9);
    expect(renderFps(25, 500)).toBeCloseTo(50, 9);
    // Không chia cho 0.
    expect(realtimeRatio(25, 0)).toBe(0);
    expect(renderFps(25, 0)).toBe(0);
  });

  it('syncLeaderFrames: 3 frame khi bật, 0 khi tắt (C2)', () => {
    expect(syncLeaderFrames(true)).toBe(3);
    expect(syncLeaderFrames(false)).toBe(0);
  });

  it('totalFrames ≤ 0 là lỗi cấu hình', async () => {
    await expect(
      runExport({
        ...BASE_OPTIONS,
        sim: makeSim(makeScenario('2cam'), 0),
        renderer: makeRenderer(),
        encoders: () => makeEncoder(),
        backend: makeBackend(),
        clock: makeClock(),
        pause: makePause(),
      }),
    ).rejects.toThrow(/totalFrames phải > 0/);
  });

  it('1 cam + xuất cam2 là lỗi cấu hình (ANS_1 A.1)', async () => {
    await expect(
      runExport({
        ...BASE_OPTIONS,
        sim: makeSim(makeScenario('1cam'), 10),
        renderer: makeRenderer(),
        encoders: () => makeEncoder(),
        backend: makeBackend(),
        clock: makeClock(),
        pause: makePause(),
      }),
    ).rejects.toThrow(/1 cam không xuất được cam2/);
  });
});

describe('export/runExport — vòng chạy bình thường', () => {
  it('render đúng số frame, ghi đủ file, trả verify', async () => {
    const track = { frames: [] as number[] };
    const backend = makeBackend();
    const result = await runExport({
      ...BASE_OPTIONS,
      sim: makeSim(makeScenario('2cam'), 10),
      renderer: makeRenderer(track),
      encoders: () => makeEncoder(),
      backend,
      clock: makeClock(),
      pause: makePause(),
    });

    expect(track.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.runId).toBe('run-1');
    expect(result.verify.ok).toBe(true);
    expect(result.frames).toEqual({ full: 10, cam1: 10, cam2: 10 });
    // 3 mp4 + 3 CSV + scenario + export_log + 8 file techgar_config.
    for (const expected of [
      'raw_full.mp4',
      'raw_cam1.mp4',
      'raw_cam2.mp4',
      'gt_frames.csv',
      'gt_events.csv',
      'frame_timestamps.csv',
      'scenario.sim3d.json',
      'export_log.json',
      'techgar_config/calibration.json',
      'techgar_config/MANIFEST.json',
      'techgar_config/README.txt',
      'techgar_config/roi_mask_cam1.json',
      'techgar_config/gate_zones.json',
    ]) {
      expect(backend.files.has(`run-1/${expected}`), `thiếu ${expected}`).toBe(true);
    }
  });

  it('onProgress gọi đúng số lần với frame tăng dần', async () => {
    const progress: { frame: number; total: number }[] = [];
    await runExport({
      ...BASE_OPTIONS,
      sim: makeSim(makeScenario('2cam'), 5),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: makeClock(),
      pause: makePause(),
      onProgress: (value) => progress.push({ frame: value.frame, total: value.total }),
    });
    expect(progress.map((entry) => entry.frame)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.every((entry) => entry.total === 5)).toBe(true);
  });

  it('export_log ghi đúng mode + tốc độ (D13)', async () => {
    const result = await runExport({
      ...BASE_OPTIONS,
      sim: makeSim(makeScenario('2cam'), 10),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: makeClock(),
      pause: makePause(),
    });
    expect(result.exportLog.mode).toBe('webcodecs');
    expect(result.exportLog.duration_frames).toBe(10);
    expect(result.exportLog.fps).toBe(25);
    expect(result.exportLog.outputs).toEqual(['full', 'cam1', 'cam2']);
    expect(result.exportLog.render_fps).toBeGreaterThan(0);
    // P7b: thời điểm kết thúc phải tiến theo đồng hồ tường, không bằng started_at.
    expect(Date.parse(result.exportLog.finished_at)).toBeGreaterThan(
      Date.parse(result.exportLog.started_at),
    );
  });

  it('timestamp của frame = frame × 40 000 µs (25 fps)', async () => {
    const stamps: number[] = [];
    const encoder: FrameEncoder = {
      addFrame: (_frame, _surface, timestampUs) => {
        stamps.push(timestampUs);
        return Promise.resolve();
      },
      finish: () => Promise.resolve(new Uint8Array([1])),
      abort: () => Promise.resolve(),
    };
    await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 4),
      renderer: makeRenderer(),
      encoders: () => encoder,
      backend: makeBackend(),
      clock: makeClock(),
      pause: makePause(),
    });
    expect(stamps).toEqual([0, 40_000, 80_000, 120_000]);
  });

  it('chế độ 1 cam: chỉ xuất full, KHÔNG có techgar_config (ANS_1 A.1)', async () => {
    const backend = makeBackend();
    const result = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('1cam'), 6),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend,
      clock: makeClock(),
      pause: makePause(),
    });
    expect(result.frames).toEqual({ full: 6, cam1: 0, cam2: 0 });
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(true);
    const techgarFiles = [...backend.files.keys()].filter((key) => key.includes('techgar_config/'));
    expect(techgarFiles).toEqual([]);
    expect(result.exportLog.warnings.join(' ')).toContain('1 cam');
  });

  it('history ngắn hơn totalFrames thì ném lỗi (P5b ghi chú 7)', async () => {
    const sim = makeSim(makeScenario('2cam'), 10);
    await expect(
      runExport({
        ...BASE_OPTIONS,
        sim: {
          ...sim,
          runToEnd: () => sim.runToEnd().slice(0, 5),
        },
        renderer: makeRenderer(),
        encoders: () => makeEncoder(),
        backend: makeBackend(),
        clock: makeClock(),
        pause: makePause(),
      }),
    ).rejects.toThrow(/history có 5 frame/);
  });

  it('renderer trả sai kích thước ⇒ lỗi, không đẩy lên BE', async () => {
    const backend = makeBackend();
    await expect(
      runExport({
        ...BASE_OPTIONS,
        outputs: ['full'],
        sim: makeSim(makeScenario('2cam'), 3),
        renderer: {
          render: () => ({ full: makeSurface(320, 320) }) as never,
        },
        encoders: () => makeEncoder(),
        backend,
        clock: makeClock(),
        pause: makePause(),
      }),
    // BRIEF_P15: kích thước mong đợi nay là `640 × s` (mặc định 1280), nên lỗi phải nêu
    // đúng số đó thay vì hằng số 640 cũ.
    ).rejects.toThrow(/cần 640×640/);
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(false);
  });
});

describe('export/runExport — D12: tạm dừng, huỷ, encoder lỗi', () => {
  it('tạm dừng thì chờ (không bỏ frame), sau đó chạy tiếp đủ frame', async () => {
    const pause = makePause();
    const track = { frames: [] as number[] };
    let calls = 0;
    const waiting: PauseGate = {
      get paused() {
        return calls > 0 && calls < 3;
      },
      waitIfPaused: () => {
        calls += 1;
        return Promise.resolve(true);
      },
    };
    const result = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 5),
      renderer: makeRenderer(track),
      encoders: () => makeEncoder(),
      backend: makeBackend(),
      clock: makeClock(),
      pause: waiting,
    });
    expect(track.frames).toEqual([0, 1, 2, 3, 4]);
    expect(result.frames.full).toBe(5);
    void pause;
  });

  it('bị huỷ trong lúc tạm dừng ⇒ ExportError(cancelled), không có file mp4', async () => {
    const backend = makeBackend();
    const cancelled: PauseGate = {
      paused: true,
      waitIfPaused: () => Promise.resolve(false),
    };
    await expect(
      runExport({
        ...BASE_OPTIONS,
        outputs: ['full'],
        sim: makeSim(makeScenario('2cam'), 5),
        renderer: makeRenderer(),
        encoders: () => makeEncoder(),
        backend,
        clock: makeClock(),
        pause: cancelled,
      }),
    ).rejects.toThrow(/Huỷ khi đang tạm dừng/);
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(false);
  });

  it('shouldCancel trả true ⇒ huỷ, gọi abort() mọi encoder, không ghi mp4', async () => {
    const backend = makeBackend();
    const abort = vi.fn(() => Promise.resolve());
    const encoder: FrameEncoder = {
      addFrame: () => Promise.resolve(),
      finish: () => Promise.resolve(new Uint8Array([1])),
      abort,
    };
    await expect(
      runExport({
        ...BASE_OPTIONS,
        outputs: ['full'],
        sim: makeSim(makeScenario('2cam'), 5),
        renderer: makeRenderer(),
        encoders: () => encoder,
        backend,
        clock: makeClock(),
        pause: makePause(),
        shouldCancel: () => true,
      }),
    ).rejects.toThrow(/Huỷ ở frame 0/);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(false);
  });

  it('encoder lỗi giữa chừng ⇒ ExportError(encoder), abort() được gọi, không có mp4 (D12)', async () => {
    const backend = makeBackend();
    const abort = vi.fn(() => Promise.resolve());
    const failing: FrameEncoder = {
      addFrame: (frame) =>
        frame === 3 ? Promise.reject(new Error('GPU mất kết nối')) : Promise.resolve(),
      finish: () => Promise.resolve(new Uint8Array([1])),
      abort,
    };
    const error = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 6),
      renderer: makeRenderer(),
      encoders: () => failing,
      backend,
      clock: makeClock(),
      pause: makePause(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).code).toBe('encoder');
    expect(String(error)).toContain('GPU mất kết nối');
    expect(abort).toHaveBeenCalled();
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(false);
  });

  it('encoder.finish() lỗi ⇒ ExportError(encoder), không để lại file', async () => {
    const backend = makeBackend();
    const encoder: FrameEncoder = {
      addFrame: () => Promise.resolve(),
      finish: () => Promise.reject(new Error('muxer hết chỗ')),
      abort: () => Promise.resolve(),
    };
    const error = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 3),
      renderer: makeRenderer(),
      encoders: () => encoder,
      backend,
      clock: makeClock(),
      pause: makePause(),
    }).catch((caught: unknown) => caught);
    expect((error as ExportError).code).toBe('encoder');
    expect(String(error)).toContain('muxer hết chỗ');
    expect(backend.files.has('run-1/raw_full.mp4')).toBe(false);
  });

  it('encoder null (trình duyệt thiếu codec) ⇒ đường PNG dự phòng (BE §4.3, D12)', async () => {
    const backend = makeBackend();
    const result = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 4),
      renderer: makeRenderer(),
      encoders: () => null,
      backend,
      clock: makeClock(),
      pause: makePause(),
    });
    // Gửi PNG cho từng frame, index bắt đầu 0.
    expect(backend.frames).toEqual([0, 1, 2, 3]);
    expect(result.exportLog.mode).toBe('png_fallback');
  });

  it('lỗi mạng khi PUT ⇒ ExportError(network) (không nuốt lỗi)', async () => {
    const backend: ExportBackend = {
      ...makeBackend(),
      putRunFile: () => Promise.reject(new Error('mất mạng')),
    };
    const error = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 3),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend,
      clock: makeClock(),
      pause: makePause(),
    }).catch((caught: unknown) => caught);
    expect((error as ExportError).code).toBe('network');
    expect(String(error)).toContain('mất mạng');
  });

  it('finalize trả ok:false thì vẫn trả kết quả (verify là dữ liệu, không phải lỗi)', async () => {
    const result = await runExport({
      ...BASE_OPTIONS,
      outputs: ['full'],
      sim: makeSim(makeScenario('2cam'), 3),
      renderer: makeRenderer(),
      encoders: () => makeEncoder(),
      backend: makeBackend(false),
      clock: makeClock(),
      pause: makePause(),
    });
    expect(result.verify.ok).toBe(false);
  });
});

describe('export/runExport — hằng số xuất', () => {
  it('3 đầu ra đúng danh sách của BE', () => {
    expect(EXPORT_OUTPUTS).toEqual(['full', 'cam1', 'cam2']);
  });
});

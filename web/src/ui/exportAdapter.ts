/**
 * Cầu nối UI → `export/runExport` (FE §7, C1, C12, D12; P9b mục 6).
 *
 * `runExport` đã có interface tiêm phụ thuộc. File này cung cấp bản chạy trong trình duyệt:
 * - `SimSource` chạy kịch bản + nhật ký sự kiện bằng chính `sim/`;
 * - `FrameRenderer` render cảnh Three.js 640×640 rồi cắt cam1/cam2 bằng `drawImage`
 *   (đúng cách P4a ghi chú: cắt từ khung 640 để vùng chồng lấn giống hệt);
 * - `PauseGate` theo `visibilitychange` (D12);
 * - `EncoderFactory` dùng WebCodecs + mediabunny (P7a), `null` ⇒ `runExport` dùng PNG.
 * - P7c: áp môi trường P8 theo keyframe tại thời điểm frame và nhiễu P8 **trước khi cắt
 *   cam** (vùng chồng lấn của cam1/cam2 giống hệt nhau).
 *
 * Chỉ đọc `export/`, `api/client.ts`, `sim/`, `render/`.
 */

import type { Object3D } from 'three';
import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type { CarModel, SimState } from '../contracts/sim';
import countSlotsPayload from '../../../data/lot/count_slots.json';
import { gateNotesFrom } from '../export/countLines';
import { step } from '../sim';
import { CAM2_CROP_X, CAMERA_FRAME_WIDTH_PX, FRAME_SIZE_PX } from '../render/index';
import { TECHGAR_SCALE } from '../export/techgarConfig';
import { EXPORT_FPS } from '../export/index';
import type { EnvApplyResult } from '../render/env/applyEnv';
import {
  applyNoise,
  enabledNoiseKinds,
  type RgbaFrame,
  type SunScreenPosition,
} from '../render/noise/cameraNoise';
import type {
  EncoderFactory,
  ExportBackend,
  ExportOutput,
  ExportProgress,
  ExportResult,
  FrameRenderer,
  FrameSurface,
  FrameSurfaces,
  PauseGate,
  SimSource,
} from '../export/runExport';
import { runExport } from '../export/runExport';
import { api } from '../api/client';
import { createWebCodecsEncoder } from '../export/webCodecsEncoder';
import { groupEventsByFrame, startSim } from '../store/scenarioModel';
import { SceneController } from './SceneController';
import { sunScreenPosition as sharedSunScreenPosition } from './liveNoise';

/** `SimSource` chạy lười: `runExport` gọi `at(0..N−1)` liên tiếp nên chỉ cần một lượt. */
export function createScenarioSimSource(lot: LotMap, scenario: Scenario): SimSource {
  const grouped = groupEventsByFrame(scenario.events);
  const frames: SimState[] = [startSim(lot, scenario)];

  const at = (frame: number): SimState => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= scenario.duration_frames) {
      throw new RangeError(
        `at(${String(frame)}): frame phải trong [0, ${String(scenario.duration_frames)})`,
      );
    }
    while (frames.length <= frame) {
      const current = frames[frames.length - 1];
      const next = step(lot, current, {
        frame: current.frame,
        events: grouped.get(current.frame) ?? [],
      });
      frames.push(next);
    }
    return frames[frame];
  };

  return {
    lot,
    scenario,
    totalFrames: scenario.duration_frames,
    at,
    runToEnd: () => {
      if (scenario.duration_frames <= 0) {
        return [];
      }
      at(scenario.duration_frames - 1);
      return frames;
    },
  };
}

/** Mặt phẳng canvas đã vẽ — vừa là nguồn PNG vừa là nguồn WebCodecs. */
class CanvasFrameSurface implements FrameSurface {
  constructor(readonly canvas: HTMLCanvasElement) {}

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  toPng(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error('Canvas.toBlob trả null — không tạo được PNG'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(reject);
      }, 'image/png');
    });
  }
}

interface DrawCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
}

function makeCanvas(width: number, height: number): DrawCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Không tạo được CanvasRenderingContext2D cho khung xuất');
  }
  return { canvas, context };
}

function cropInto(
  source: HTMLCanvasElement,
  target: DrawCanvas,
  sourceX: number,
  sourceWidth: number,
): void {
  const { canvas, context } = target;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    sourceX,
    0,
    sourceWidth,
    FRAME_SIZE_PX,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

export interface CanvasExportRenderer extends FrameRenderer {
  dispose(): void;
}

/**
 * Renderer xuất: một cảnh riêng (không đụng khung xem live), camera dataset 1 cam
 * 640×640, rồi cắt cam1/cam2 từ chính khung đó.
 */
export function createCanvasExportRenderer(
  lot: LotMap,
  templates: ReadonlyMap<CarModel, Object3D>,
  scenario: Scenario,
  /**
   * Hệ số phóng cam (BRIEF_P15 mục A). Cảnh vẫn render ở **640×640** (nhiễu áp ở
   * khung đó, đúng FE §6), rồi `cropInto` vừa cắt vừa phóng lên canvas đầu ra
   * — nên chỉ cần đặt kích thước canvas đích là đủ.
   */
  scale = 1,
): CanvasExportRenderer {
  const webglCanvas = document.createElement('canvas');
  webglCanvas.width = FRAME_SIZE_PX;
  webglCanvas.height = FRAME_SIZE_PX;
  const controller = new SceneController({
    canvas: webglCanvas,
    lot,
    mode: 'dataset',
    count: '1cam',
    antialias: false,
    shadows: false,
    // P8: mây/mưa/đèn/trời theo keyframe của kịch bản.
    environment: true,
    envSeed: scenario.seed,
  });
  controller.setTemplates(templates);

  // `full` là ảnh toàn cảnh cho người xem, không vào TechGAR ⇒ giữ 640×640 (BRIEF: raw_full "tùy").
  // Chỉ cam1/cam2 phóng theo `s` để khớp `image_size` của `techgar_config`.
  const full = makeCanvas(FRAME_SIZE_PX, FRAME_SIZE_PX);
  const cam1 = makeCanvas(
    Math.round(CAMERA_FRAME_WIDTH_PX * scale),
    Math.round(FRAME_SIZE_PX * scale),
  );
  const cam2 = makeCanvas(
    Math.round(CAMERA_FRAME_WIDTH_PX * scale),
    Math.round(FRAME_SIZE_PX * scale),
  );
  const noiseKinds = enabledNoiseKinds(scenario.noise);
  let previousNoise: RgbaFrame | null = null;

  return {
    render(state: SimState, outputs: readonly ExportOutput[]): FrameSurfaces {
      // `FrameSurfaces` cần đủ 3 khoá; vẫn vẽ cả 3 cho đơn giản, `outputs` chỉ để
      // ghi nhận tập được yêu cầu (rỗng/khác nhau không đổi hình).
      void outputs;

      // Môi trường theo đúng thời điểm frame (giây video), rồi mới render cảnh.
      const env = controller.applyEnvironment(
        scenario.env.keyframes,
        state.frame / EXPORT_FPS,
      );
      controller.applyState(state, null);
      const source = controller.render();
      // Chép sang canvas 2D ngay trong cùng tác vụ để không phụ thuộc
      // `preserveDrawingBuffer` của WebGL.
      contextCopy(source, full);

      // Nhiễu áp lên khung 640 TRƯỚC khi cắt cam1/cam2 (FE §6).
      if (noiseKinds.length > 0) {
        const image = full.context.getImageData(
          0,
          0,
          FRAME_SIZE_PX,
          FRAME_SIZE_PX,
        );
        const input: RgbaFrame = {
          width: FRAME_SIZE_PX,
          height: FRAME_SIZE_PX,
          data: new Uint8ClampedArray(image.data),
        };
        const result = applyNoise(input, scenario.noise, {
          frame: state.frame,
          raining: env !== null && env.rainIntensity > 0,
          sun: sunScreenPosition(env),
        });
        const chosen =
          result.holdPrevious && previousNoise !== null
            ? previousNoise
            : result.frame;
        previousNoise = chosen;
        // `createImageData` tránh lệch kiểu `Uint8ClampedArray<ArrayBufferLike>` của
        // constructor `ImageData` trong TS 5.9.
        const output = full.context.createImageData(chosen.width, chosen.height);
        output.data.set(chosen.data);
        full.context.putImageData(output, 0, 0);
      }

      // Cắt từ khung 640 ĐÃ áp nhiễu (không cắt từ canvas WebGL).
      cropInto(full.canvas, cam1, 0, CAMERA_FRAME_WIDTH_PX);
      cropInto(full.canvas, cam2, CAM2_CROP_X, CAMERA_FRAME_WIDTH_PX);
      return {
        full: new CanvasFrameSurface(full.canvas),
        cam1: new CanvasFrameSurface(cam1.canvas),
        cam2: new CanvasFrameSurface(cam2.canvas),
      };
    },
    dispose(): void {
      controller.dispose();
    },
  };
}

/** Vị trí mặt trời trên khung 640 cho `flare` (cùng công thức `renderEntry.ts` P8). */
function sunScreenPosition(
  result: EnvApplyResult | null,
): SunScreenPosition | null {
  return sharedSunScreenPosition(result);
}

function contextCopy(source: HTMLCanvasElement, target: DrawCanvas): void {
  target.context.clearRect(0, 0, target.canvas.width, target.canvas.height);
  target.context.drawImage(source, 0, 0);
}

/** Cổng tạm dừng theo `visibilitychange` (D12) + huỷ được từ UI. */
export class BrowserPauseGate implements PauseGate {
  private cancelled = false;
  private wake: (() => void) | null = null;
  private readonly onVisibility = (): void => {
    this.wake?.();
    this.wake = null;
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get paused(): boolean {
    return document.visibilityState === 'hidden';
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  async waitIfPaused(): Promise<boolean> {
    while (!this.cancelled && this.paused) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return !this.cancelled;
  }

  cancel(): void {
    this.cancelled = true;
    this.wake?.();
    this.wake = null;
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.cancel();
  }
}

/** Băm ổn định của kịch bản cho `techgar_config/MANIFEST.json` (FNV-1a 32-bit). */
export function hashScenario(scenario: Scenario): string {
  const text = JSON.stringify(scenario);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface ScenarioExportOptions {
  readonly lot: LotMap;
  readonly scenario: Scenario;
  readonly templates: ReadonlyMap<CarModel, Object3D>;
  readonly outputs: readonly ExportOutput[];
  readonly name: string;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export interface ScenarioExportHandle {
  readonly result: Promise<ExportResult>;
  cancel(): void;
  /**
   * Lý do WebCodecs không dùng được cho đầu ra nào (rỗng = dùng WebCodecs hết).
   * Mảng được điền trong lúc `runExport` tạo encoder; đọc sau khi xong.
   */
  readonly fallbackReasons: readonly string[];
}

/**
 * Bắt đầu một lần xuất. UI giữ `handle.result` để hiện tiến độ/verify và gọi
 * `handle.cancel()` khi người dùng bấm Huỷ.
 */
export function startScenarioExport(options: ScenarioExportOptions): ScenarioExportHandle {
  const gate = new BrowserPauseGate();
  // Hệ số phóng cam dùng chung cho **cả** renderer (kích thước canvas đầu ra) và
  // `techgar_config` (slot/mask/calibration) — lệch nhau là `verify` của BE fail ngay.
  const scale = TECHGAR_SCALE;
  const renderer = createCanvasExportRenderer(
    options.lot,
    options.templates,
    options.scenario,
    scale,
  );
  const source = createScenarioSimSource(options.lot, options.scenario);
  const backend: ExportBackend = api;
  const fallbackReasons: string[] = [];

  const encoders: EncoderFactory = async (output, size) => {
    try {
      const encoder = await createWebCodecsEncoder(size[0], size[1]);
      if (encoder === null) {
        fallbackReasons.push(
          `${output}: trình duyệt không encode được H.264 ${String(size[0])}×${String(size[1])}`,
        );
      }
      return encoder;
    } catch (error) {
      fallbackReasons.push(
        `${output}: WebCodecs lỗi khi tạo encoder (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return null;
    }
  };

  const result = runExport({
    sim: source,
    renderer,
    // Đường chính WebCodecs + mediabunny; không encode được H.264 thì factory trả null
    // (ghi lý do) và runExport tự dùng PNG fallback.
    encoders,
    backend,
    clock: { nowMs: () => performance.now() },
    pause: gate,
    name: options.name,
    outputs: options.outputs,
    scenarioHash: hashScenario(options.scenario),
    startedAt: new Date().toISOString(),
    scale,
    // Ô không đếm được cổng (P11c mục 2): GT để rỗng cột cổng + ghi lý do, để
    // `verify` mục 3 không báo sai thứ tự cổng cho xe ở ô mà vạch/camera không đo được.
    gateNotes: gateNotesFrom(countSlotsPayload),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    shouldCancel: () => gate.isCancelled,
  }).finally(() => {
    renderer.dispose();
    gate.dispose();
  });

  return {
    result,
    cancel: () => gate.cancel(),
    fallbackReasons,
  };
}

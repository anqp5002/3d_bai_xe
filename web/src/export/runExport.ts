/**
 * Vòng xuất offline (FE §7, C1, C12, D12).
 *
 * Nguyên tắc:
 * - **Chạy lại từ đầu**, không dùng `requestAnimationFrame` và không gắn với thời gian
 *   thực: mỗi frame gọi `sim.at(frame)` rồi render vào khung 640×640, cắt cam1/cam2.
 * - **`history` lưu đủ mọi frame liên tiếp** — `gtEvents` cần để tính `gate_in_frame` /
 *   `gate_out_frame` chính xác (P5b ghi chú 7).
 * - **D12**: tab bị ẩn thì *tạm dừng* và báo cho UI; encoder lỗi thì *huỷ*, không bao giờ
 *   để lại mp4 thiếu frame. Mọi lỗi ném lên, không nuốt (R2).
 *
 * Toàn bộ phụ thuộc ngoài (render, encoder, mạng, đồng hồ, trạng thái tab) đều **tiêm vào**
 * qua interface, nên test chạy bằng Node với giả lập — không cần WebGL/WebCodecs.
 */

import type { LotMap } from '../contracts/lot';
import type { CameraMode, Scenario } from '../contracts/scenario';
import type { SimState, Warning } from '../contracts/sim';
import type { GateNote, GtEventRow, GtFrameRow } from '../contracts/gt';
import { gtEventsCsv, gtEvents, gtFramesCsv, frameTimestampsCsv, gtRow, collectCarIds } from '../sim/gtCompute';
import { parkClipEpisodes, summarizeEpisodes, type ParkClipEpisode, type ParkClipEpisodeSummary } from '../sim/parkClip';
import { buildCountLines, lotWithCountLines } from './countLines';
import { gtGateIdeal, gtGateIdealCsv } from './gtGateIdeal';
import { EXPORT_FPS, SYNC_LEADER_FRAMES } from './index';
import { buildTechgarConfig } from './techgarBundle';
import { TECHGAR_SCALE } from './techgarConfig';
import type { VerifyReport } from '../api/client';

/** Đầu ra có thể chọn (BE §3 `outputs`). */
export const EXPORT_OUTPUTS = ['full', 'cam1', 'cam2'] as const;
export type ExportOutput = (typeof EXPORT_OUTPUTS)[number];

/** Kích thước mỗi đầu ra **ở hệ số s = 1** (BE §4.2). */
export const OUTPUT_SIZES: Readonly<Record<ExportOutput, readonly [number, number]>> = {
  full: [640, 640],
  cam1: [400, 640],
  cam2: [400, 640],
};

/**
 * Kích thước mỗi đầu ra sau khi nhân hệ số phóng cam `s` (BRIEF_P15 mục A).
 *
 * **`cam1`/`cam2` mới là đầu vào TechGAR** nên phải khớp `image_size` trong `techgar_config`
 * (800×1280 khi s=2); lệch là `verify` báo sai.
 *
 * **`full` giữ nguyên 640×640.** BRIEF ghi rõ `raw_full` là "tùy", và nó là ảnh toàn cảnh cho
 * người xem, không đưa vào bộ dò ⇒ không có `image_size` nào để đối chiếu. Giữ cố định còn giúp
 * chế độ 1 cam (không sinh `techgar_config`, ANS_1 A.1) kiểm được mà không cần suy ra `s`.
 */
export function outputSizesAt(
  scale: number,
): Readonly<Record<ExportOutput, readonly [number, number]>> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new ExportError('config', `outputSizesAt: hệ số phải > 0, nhận ${String(scale)}`);
  }
  return {
    full: [640, 640],
    cam1: [Math.round(400 * scale), Math.round(640 * scale)],
    cam2: [Math.round(400 * scale), Math.round(640 * scale)],
  };
}

/** Lỗi của vòng xuất; `code` để UI phân biệt huỷ / lỗi encoder / lỗi mạng. */
export class ExportError extends Error {
  override readonly name = 'ExportError';

  constructor(
    readonly code: 'encoder' | 'cancelled' | 'network' | 'interrupted' | 'config',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Ba khung ảnh của một frame đã render.
 *
 * Trong trình duyệt đây là `OffscreenCanvas`/`HTMLCanvasElement`; trong test là giả lập.
 * Chỉ cần `width`/`height` để kiểm kích thước và một cách lấy byte để đẩy lên BE.
 */
export interface FrameSurface {
  readonly width: number;
  readonly height: number;
  /** Byte PNG của khung (đường dự phòng BE §4.3). Có thể nặng, chỉ gọi khi cần. */
  toPng(): Promise<Uint8Array>;
}

/** Renderer trừu tượng: nhận state, trả 3 khung đã cắt. */
export interface FrameRenderer {
  /**
   * Render một frame. `outputs` cho biết cần khung nào (P7 có thể bỏ cam2 nếu chọn 1 cam).
   * Phải trả **đúng kích thước** `OUTPUT_SIZES` — sai là lỗi lập trình, `runExport` kiểm.
   */
  render(state: SimState, outputs: readonly ExportOutput[]): FrameSurfaces;
}

/** Bộ khung của một frame. */
export type FrameSurfaces = Readonly<Record<ExportOutput, FrameSurface>>;

/**
 * Encoder trừu tượng cho **một** đầu ra.
 *
 * Hiện thực thật dùng WebCodecs + mediabunny (`WebCodecsEncoder`); test dùng giả lập.
 */
export interface FrameEncoder {
  /** Nạp một frame; `timestampUs = frame × 40000` (25 fps). */
  addFrame(frame: number, surface: FrameSurface, timestampUs: number): Promise<void>;
  /** Kết thúc và trả file MP4 (hoặc `null` nếu encoder không tạo được file). */
  finish(): Promise<Uint8Array | null>;
  /** Huỷ giữa chừng; phải dọn tài nguyên và **không** để lại file dở (D12). */
  abort(): Promise<void>;
}

/**
 * Hàm tạo encoder cho một đầu ra. `null` = không dùng được (báo lý do ở nơi tạo) ⇒
 * `runExport` đi đường PNG. Có thể trả Promise để kiểm `canEncodeVideo` bất đồng bộ
 * trước khi tạo encoder (P7b).
 */
export type EncoderFactory = (
  output: ExportOutput,
  size: readonly [number, number],
) => FrameEncoder | null | Promise<FrameEncoder | null>;

/**
 * Cổng tạm dừng (D12: tab ẩn thì dừng). Ở trình duyệt nối với `visibilitychange`;
 * trong test là hàm điều khiển được.
 */
export interface PauseGate {
  /** Chờ tới khi được phép chạy tiếp; `false` = đã bị huỷ trong lúc chờ. */
  waitIfPaused(): Promise<boolean>;
  /** Có đang tạm dừng không (để log/báo UI). */
  readonly paused: boolean;
}

/** Đồng hồ trừu tượng (chỉ dùng để đo tốc độ xuất, không ảnh hưởng kết quả). */
export interface Clock {
  nowMs(): number;
}

/**
 * Nguồn frame của mô phỏng.
 *
 * `history` **phải** trả mọi frame liên tiếp 0…totalFrames−1 (P5b ghi chú 7): `gtEvents`
 * cần toàn bộ chuỗi để tìm frame cắt cổng.
 */
export interface SimSource {
  readonly lot: LotMap;
  readonly scenario: Scenario;
  readonly totalFrames: number;
  /** Trạng thái tại frame `frame` (0-based, `0 ≤ frame < totalFrames`). */
  at(frame: number): SimState;
  /** Chạy hết và trả lịch sử đủ mọi frame. */
  runToEnd(): readonly SimState[];
}

/** Tập con của `api` mà `runExport` cần — để test tiêm bản giả. */
export interface ExportBackend {
  createRun(body: {
    readonly name: string;
    readonly outputs: readonly ExportOutput[];
    readonly duration_frames: number;
    readonly fps: number;
  }): Promise<{ readonly run_id: string }>;
  putRunFile(runId: string, relPath: string, body: Blob | ArrayBuffer): Promise<void>;
  postRunFrame(runId: string, frameIndex: number, png: Blob): Promise<void>;
  finalize(runId: string): Promise<VerifyReport>;
}

/** Tuỳ chọn một lần xuất. */
export interface ExportOptions {
  readonly sim: SimSource;
  readonly renderer: FrameRenderer;
  readonly encoders: EncoderFactory;
  readonly backend: ExportBackend;
  readonly clock: Clock;
  readonly pause: PauseGate;
  /** Tên lần chạy (BE §2: `[A-Za-z0-9_-]{1,40}`). */
  readonly name: string;
  /** Đầu ra cần xuất; rỗng là lỗi cấu hình. */
  readonly outputs: readonly ExportOutput[];
  /** Hash kịch bản để ghi vào `techgar_config/MANIFEST.json`. */
  readonly scenarioHash: string;
  /** ISO 8601 của thời điểm bắt đầu (tiêm vào để test tất định). */
  readonly startedAt: string;
  /** Bật 3 frame đánh dấu đồng bộ khi quay màn hình (C2). Mặc định `false` khi xuất file. */
  readonly syncLeader?: boolean;
  /**
   * Hệ số phóng ảnh cam khi xuất (BRIEF_P15 mục A). Mặc định `TECHGAR_SCALE` (= 2).
   *
   * Áp cho `raw_cam1/2.mp4`, `raw_full.mp4`, và **mọi** file pixel trong `techgar_config`
   * (slots, mask, calibration, MANIFEST) — chúng phải cùng một `s` thì TechGAR mới khớp.
   */
  readonly scale?: number;
  /**
   * Ô không đếm được cổng → lý do (P11c mục 2, ANS_17).
   *
   * Sinh từ `data/lot/count_slots.json` bằng `gateNotesFrom`. Bắt buộc: nếu bỏ trống thì GT
   * sẽ ghi `gate_in`/`gate_out` cho xe ở ô không đo được ⇒ `verify` mục 3 sai âm thầm.
   */
  readonly gateNotes?: ReadonlyMap<string, GateNote>;
  /** Gọi sau mỗi frame để UI vẽ thanh tiến trình. */
  readonly onProgress?: (progress: ExportProgress) => void;
  /** Hỏi trước khi ghi từng frame (test dùng để mô phỏng huỷ). */
  readonly shouldCancel?: () => boolean;
}

/** Tiến trình một lần xuất. */
export interface ExportProgress {
  readonly frame: number;
  readonly total: number;
  /** Tỉ lệ so với thời gian thực (video_seconds / wall_seconds). > 1 là nhanh hơn thật. */
  readonly realtimeRatio: number;
  readonly paused: boolean;
}

/** Kết quả một lần xuất. */
export interface ExportResult {
  readonly runId: string;
  readonly verify: VerifyReport;
  readonly exportLog: ExportLog;
  /** Số frame đã ghi cho từng đầu ra. */
  readonly frames: Readonly<Record<ExportOutput, number>>;
}

/**
 * `park_clip` tổng hợp trong `export_log.json` (ANS_4 mục 4).
 *
 * `episodes` là các **đợt lấn liên tiếp** (gộp frame liền nhau của cùng xe + ô + ô kề) do
 * `sim/parkClip.parkClipEpisodes` sinh; `summary` là số đợt / độ sâu max / phân bố hàng.
 * `park_clip` **không** phải lỗi xuất — nó là dung sai hình ảnh đã được ANS_4/5/6 duyệt,
 * nên ghi ra để QA đọc, không làm `verify.ok` sai.
 */
export interface ExportParkClip {
  readonly episodes: readonly ParkClipEpisode[];
  readonly summary: ParkClipEpisodeSummary;
}

/**
 * Đổi `kind` của cảnh báo leo thang thành `park_clip` để dùng lại bộ gộp đợt.
 *
 * `sim/parkClip.parkClipEpisodes` chỉ nhận `kind === 'park_clip'` (nó là code của `sim/`, TASK
 * P10e **cấm sửa**). Cơ chế gộp đợt (cùng xe + ô + ô kề + frame liền nhau) giống hệt cho cả
 * hai loại, nên thay vì chép lại thuật toán, ta đổi nhãn ngay tại biên export. Mọi trường khác
 * (`frame`, `car_id`, `slot`, `neighbour_slot`, `neighbour_car_id`, `depth_m`) giữ nguyên —
 * `parkClipWarning` sinh cả hai loại với cùng bộ trường (xem `sim/parkClip.ts:167`).
 */
function asParkClipKind(warning: Warning): Warning {
  return warning.kind === 'park_clip' ? warning : { ...warning, kind: 'park_clip' };
}

/** `export_log.json` (BE §2, D13: ghi tốc độ thật). */
export interface ExportLog {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_frames: number;
  readonly fps: number;
  readonly outputs: readonly ExportOutput[];
  readonly render_fps: number;
  readonly realtime_ratio: number;
  readonly paused_seconds: number;
  readonly mode: 'webcodecs' | 'png_fallback';
  readonly warnings: readonly string[];
  /** Các đợt `park_clip` của lần xuất (rỗng nếu không có). */
  readonly park_clip: ExportParkClip;
  /**
   * Các đợt **leo thang** `park_clip_escalated` (ANS_13).
   *
   * Chỉ xảy ra khi xe ở `parking_in`/`leaving_slot` bị chặn **chỉ** bởi xe đỗ ở ô kề cùng
   * hàng và không tiến triển ≥ 4 s; trần tạm nâng lên 0,35 m. **Kỳ vọng 0 ở K2–K8** — nếu
   * có thì `REPORT` phải ghi rõ (ANS_13 mục 3), nên tách khỏi `park_clip` để không lẫn.
   */
  readonly park_clip_escalated: ExportParkClip;
}

/** Kiểm `outputs` hợp lệ và không rỗng (R2: báo lỗi sớm). */
export function validateOutputs(outputs: readonly ExportOutput[]): readonly ExportOutput[] {
  if (outputs.length === 0) {
    throw new ExportError('config', 'outputs rỗng: phải chọn ít nhất một đầu ra');
  }
  for (const output of outputs) {
    if (!(EXPORT_OUTPUTS as readonly string[]).includes(output)) {
      throw new ExportError('config', `outputs có giá trị lạ: ${String(output)}`);
    }
  }
  if (new Set(outputs).size !== outputs.length) {
    throw new ExportError('config', `outputs bị trùng: ${outputs.join(', ')}`);
  }
  return outputs;
}

/** Tính `cams` của GT: ở chế độ 1 cam chỉ `cam1` = toàn khung (FE §4.6). */
export function cameraModeOf(scenario: Scenario): CameraMode {
  return scenario.camera_mode;
}

/**
 * Chạy một lần xuất đầy đủ (FE §7 bước 1–5).
 *
 * Trình tự:
 * 1. Kiểm tham số + tạo `run` trên BE.
 * 2. Chạy mô phỏng tới hết, **lưu đủ history**.
 * 3. Vòng render từng frame: kiểm/tạm dừng theo `pause`, mã hoá, gọi `onProgress`.
 * 4. Ghi GT CSV + `scenario.sim3d.json` + `techgar_config/` + `export_log.json` lên BE.
 * 5. Gọi `finalize`, trả `verify`.
 *
 * Bất kỳ lỗi encoder nào ⇒ `abort()` mọi encoder + ném `ExportError('encoder')`.
 * Bị huỷ ⇒ ném `ExportError('cancelled')`. Không trả kết quả dở.
 */
export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const outputs = validateOutputs(options.outputs);
  const { sim, renderer, encoders, backend, clock, pause } = options;

  if (sim.totalFrames <= 0) {
    throw new ExportError('config', `totalFrames phải > 0, nhận ${String(sim.totalFrames)}`);
  }
  const mode = cameraModeOf(sim.scenario);
  // 1 cam không xuất cam2 (ANS_1 A.1: xuất raw_full + GT, không có techgar_config).
  if (mode === '1cam' && outputs.includes('cam2')) {
    throw new ExportError('config', 'chế độ 1 cam không xuất được cam2 (ANS_1 A.1)');
  }

  const startedMs = clock.nowMs();
  const created = await backend.createRun({
    name: options.name,
    outputs,
    duration_frames: sim.totalFrames,
    fps: EXPORT_FPS,
  });
  const runId = created.run_id;
  // Mọi đầu ra dùng cùng hệ số `s` (BRIEF_P15): ảnh cam 800×1280 khi s=2.
  const scale = options.scale ?? TECHGAR_SCALE;
  const sizes = outputSizesAt(scale);

  // Tạo encoder trước khi render để fail sớm nếu trình duyệt thiếu codec (D12).
  const active: { output: ExportOutput; encoder: FrameEncoder }[] = [];
  let modeUsed: 'webcodecs' | 'png_fallback' = 'webcodecs';
  try {
    for (const output of outputs) {
      const encoder = await encoders(output, sizes[output]);
      if (encoder === null) {
        modeUsed = 'png_fallback';
        continue;
      }
      active.push({ output, encoder });
    }
  } catch (error) {
    throw new ExportError('encoder', `Không tạo được encoder: ${String(error)}`, error);
  }

  const abortAll = async (): Promise<void> => {
    for (const { encoder } of active) {
      try {
        await encoder.abort();
      } catch (abortError) {
        // Không che lỗi gốc, nhưng phải kể ra là có lỗi khi dọn.
        console.error('runExport: lỗi khi abort encoder', abortError);
      }
    }
  };

  /** Số frame đã ghi cho mỗi đầu ra (để kiểm và ghi log). */
  const frameCounts: Record<ExportOutput, number> = { full: 0, cam1: 0, cam2: 0 };
  let pausedMs = 0;
  const warnings: string[] = [];

  try {
    for (let frame = 0; frame < sim.totalFrames; frame += 1) {
      if (options.shouldCancel?.() === true) {
        throw new ExportError('cancelled', `Huỷ ở frame ${String(frame)}`);
      }
      const pausedAt = clock.nowMs();
      const allowed = await pause.waitIfPaused();
      pausedMs += clock.nowMs() - pausedAt;
      if (!allowed) {
        throw new ExportError('cancelled', `Huỷ khi đang tạm dừng ở frame ${String(frame)}`);
      }

      const state = sim.at(frame);
      const surfaces = renderer.render(state, outputs);

      // Kiểm kích thước: sai là lỗi lập trình, không được đẩy lên BE.
      for (const output of outputs) {
        const surface = surfaces[output];
        const [expectedWidth, expectedHeight] = sizes[output];
        if (surface.width !== expectedWidth || surface.height !== expectedHeight) {
          throw new ExportError(
            'encoder',
            `Frame ${String(frame)} đầu ra ${output} là ${String(surface.width)}×${String(surface.height)}, ` +
              `cần ${String(expectedWidth)}×${String(expectedHeight)}`,
          );
        }
      }

      const timestampUs = frame * Math.round(1_000_000 / EXPORT_FPS);
      for (const { output, encoder } of active) {
        await encoder.addFrame(frame, surfaces[output], timestampUs);
        frameCounts[output] += 1;
      }

      // Đường PNG dự phòng: gửi ngay từng frame (BE §4.3, `%06d.png` bắt đầu 0 — D12).
      if (modeUsed === 'png_fallback') {
        for (const output of outputs) {
          if (active.some((entry) => entry.output === output)) {
            continue;
          }
          const png = await surfaces[output].toPng();
          const pngBuffer = toArrayBuffer(png);
          await backend.postRunFrame(runId, frame, new Blob([pngBuffer], { type: 'image/png' }));
          frameCounts[output] += 1;
        }
      }

      options.onProgress?.({
        frame: frame + 1,
        total: sim.totalFrames,
        realtimeRatio: realtimeRatio(frame + 1, clock.nowMs() - startedMs - pausedMs),
        paused: pause.paused,
      });
    }

    // Kết thúc encoder: ghi file MP4 lên BE.
    for (const { output, encoder } of active) {
      let bytes: Uint8Array | null;
      try {
        bytes = await encoder.finish();
      } catch (error) {
        throw new ExportError(
          'encoder',
          `Encoder ${output} lỗi khi kết thúc: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      if (bytes === null) {
        warnings.push(`encoder ${output} không tạo được file (bỏ qua)`);
        continue;
      }
      await putFile(backend, runId, fileNameFor(output), toArrayBuffer(bytes));
    }

    // Ghi GT + kịch bản + config sau khi có đủ history (P5b ghi chú 7).
    const history = sim.runToEnd();
    if (history.length !== sim.totalFrames) {
      throw new ExportError(
        'config',
        `history có ${String(history.length)} frame nhưng totalFrames = ${String(sim.totalFrames)}; ` +
          'gtEvents cần đủ mọi frame liên tiếp',
      );
    }
    const frameRows: GtFrameRow[] = history.map((state) => gtRow(sim.lot, state, mode));
    const carIds = collectCarIds(history);
    // GT `gate_in_frame`/`gate_out_frame` tính tại **vạch đếm** (ANS_14/P11), không phải vạch
    // cổng vẽ: cổng vẽ sát mép khung nên tracker chưa có Global ID khi xe đi qua. Cùng một
    // `countLines` dùng cho cả `gt_events.csv` và `gate_zones.json` ⇒ hai bên không thể lệch.
    const countLines = buildCountLines(sim.lot);
    const gateNotes = options.gateNotes ?? new Map<string, GateNote>();
    const flaggedSlots = [...gateNotes.entries()].map(([slot, flag]) => ({ slot, flag }));
    const eventRows: GtEventRow[] = [
      ...gtEvents(lotWithCountLines(sim.lot, countLines), history, gateNotes),
    ];

    await putFile(backend, runId, 'gt_frames.csv', encode(gtFramesCsv(frameRows, carIds)));
    await putFile(backend, runId, 'gt_events.csv', encode(gtEventsCsv(eventRows)));

    // ANS_18: GT "bộ đếm lý tưởng" — chạy đúng máy trạng thái của
    // `gate_session_controller.py:498-534` trên quỹ đạo tâm thật. Khác `gt_events.csv` ở chỗ:
    // `gt_events` là ngữ nghĩa (xe có vào/ra bãi không), còn file này là con số một tracker
    // hoàn hảo sẽ đếm được với vạch/camera hiện tại.
    const gateIdealRows = gtGateIdeal(sim.lot, history);
    await putFile(
      backend,
      runId,
      'gt_gate_ideal.csv',
      encode(gtGateIdealCsv(gateIdealRows)),
    );
    await putFile(
      backend,
      runId,
      'frame_timestamps.csv',
      encode(frameTimestampsCsv(sim.totalFrames)),
    );
    await putFile(backend, runId, 'scenario.sim3d.json', encode(`${JSON.stringify(sim.scenario, null, 1)}\n`));

    const bundle = buildTechgarConfig({
      lot: sim.lot,
      cameraMode: mode,
      runId,
      scenarioHash: options.scenarioHash,
      generatedAt: options.startedAt,
      warnings,
      countLines,
      scale,
      ...(flaggedSlots.length === 0 ? {} : { flaggedSlots }),
    });
    if (bundle !== null) {
      for (const file of bundle.files) {
        await putFile(backend, runId, `techgar_config/${file.path}`, encode(file.text));
      }
    } else {
      warnings.push('chế độ 1 cam: không xuất techgar_config/ (TechGAR cần 2 cam)');
    }

    // `park_clip` từ đúng history đã dùng để tính GT (cùng nguồn dữ liệu, không đọc lại).
    const parkClipWarnings = history.flatMap((state) =>
      state.warnings.filter((warning) => warning.kind === 'park_clip'),
    );
    const parkClip: ExportParkClip = {
      episodes: parkClipEpisodes(parkClipWarnings, sim.lot),
      summary: summarizeEpisodes(parkClipEpisodes(parkClipWarnings, sim.lot)),
    };

    // `park_clip_escalated` (ANS_13): cùng cơ chế nhưng **loại riêng**, kỳ vọng 0 ở K2–K8.
    // Tách khỏi `park_clip` để ai đọc log thấy ngay có leo thang hay không, không phải lọc.
    // Đổi nhãn ở biên vì `sim/parkClip` (không được sửa) chỉ gộp `kind === 'park_clip'`.
    const escalatedWarnings = history
      .flatMap((state) =>
        state.warnings.filter((warning) => warning.kind === 'park_clip_escalated'),
      )
      .map(asParkClipKind);
    const parkClipEscalated: ExportParkClip = {
      episodes: parkClipEpisodes(escalatedWarnings, sim.lot),
      summary: summarizeEpisodes(parkClipEpisodes(escalatedWarnings, sim.lot)),
    };

    const finishedMs = clock.nowMs();
    const exportLog: ExportLog = {
      run_id: runId,
      started_at: options.startedAt,
      // Luôn cộng thời gian tường; giữ nguyên chuỗi ISO đã tiêm nếu nó hợp lệ.
      finished_at: new Date(
        Date.parse(options.startedAt) + (finishedMs - startedMs),
      ).toISOString(),
      duration_frames: sim.totalFrames,
      fps: EXPORT_FPS,
      outputs,
      render_fps: renderFps(sim.totalFrames, finishedMs - startedMs - pausedMs),
      realtime_ratio: realtimeRatio(sim.totalFrames, finishedMs - startedMs - pausedMs),
      paused_seconds: pausedMs / 1000,
      mode: modeUsed,
      warnings,
      park_clip: parkClip,
      park_clip_escalated: parkClipEscalated,
    };
    await putFile(backend, runId, 'export_log.json', encode(`${JSON.stringify(exportLog, null, 1)}\n`));

    const verify = await backend.finalize(runId);
    return { runId, verify, exportLog, frames: frameCounts };
  } catch (error) {
    // D12: huỷ thì dọn encoder, không để lại file dở.
    await abortAll();
    if (error instanceof ExportError) {
      throw error;
    }
    throw new ExportError(
      'encoder',
      `Lỗi khi xuất: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/** Tên file MP4 trên BE cho một đầu ra (BE §2: giữ tên bộ cũ). */
export function fileNameFor(output: ExportOutput): string {
  switch (output) {
    case 'full':
      return 'raw_full.mp4';
    case 'cam1':
      return 'raw_cam1.mp4';
    case 'cam2':
      return 'raw_cam2.mp4';
    default: {
      const exhaustive: never = output;
      throw new ExportError('config', `Đầu ra lạ: ${String(exhaustive)}`);
    }
  }
}

/** Đổi Uint8Array sang ArrayBuffer độc lập (không chia sẻ bộ đệm). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Mã hoá chuỗi UTF-8 thành `ArrayBuffer` (BE nhận nguyên file). */
function encode(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Gọi `putRunFile` và bọc lỗi mạng thành `ExportError('network')`. */
async function putFile(
  backend: ExportBackend,
  runId: string,
  path: string,
  body: ArrayBuffer,
): Promise<void> {
  try {
    await backend.putRunFile(runId, path, body);
  } catch (error) {
    throw new ExportError(
      'network',
      `Gửi ${path} lên BE thất bại: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/** Tỉ lệ so với thời gian thực: giây video / giây tường (D13: chỉ để báo). */
export function realtimeRatio(frames: number, wallMs: number): number {
  if (wallMs <= 0) {
    return 0;
  }
  const videoSeconds = frames / EXPORT_FPS;
  return videoSeconds / (wallMs / 1000);
}

/** Số frame render được mỗi giây tường. */
export function renderFps(frames: number, wallMs: number): number {
  if (wallMs <= 0) {
    return 0;
  }
  return frames / (wallMs / 1000);
}

/** Số frame đánh dấu đồng bộ cần chèn khi quay màn hình (C2). */
export function syncLeaderFrames(enabled: boolean): number {
  return enabled ? SYNC_LEADER_FRAMES : 0;
}

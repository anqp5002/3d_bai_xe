/**
 * Encoder WebCodecs + mediabunny cho một đầu ra (FE §7 bước 2, C12, D12).
 *
 * Dùng `mediabunny` (bản kế thừa `mp4-muxer`, đã ghim `1.65.0` ở P1) để đóng gói MP4 và
 * `VideoEncoder` của WebCodecs để mã hoá H.264. Chỉ chạy trong trình duyệt — file này
 * **không** được import bởi test Node (test dùng `FrameEncoder` giả ở `runExport.test.ts`).
 *
 * D12:
 * - Kiểm `isConfigSupported` cho **từng kích thước** trước khi mã hoá; không hỗ trợ ⇒ trả
 *   `null` để `runExport` chuyển sang đường PNG dự phòng.
 * - Lỗi encoder ⇒ ném lên và `abort()` dọn dẹp, không để lại mp4 thiếu frame.
 */

import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';
import { EXPORT_FPS } from './index';
import { ExportError, type FrameEncoder, type FrameSurface, type VideoSink } from './runExport';

/** Kích thước khúc đẩy lên BE khi mã hoá dòng, byte (8 MiB). */
export const STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Cấu hình H.264 mặc định (FE §7: ~4 Mbps cho 640×640, keyframe mỗi 50 frame).
 *
 * **Level phải chọn theo kích thước** (BRIEF_P15 mục A): `avc1.42E01F` là Baseline **level 3.1**,
 * giới hạn `MaxFS = 3600` macroblock = **921 600 px**. Ở s=1 (400×640, 640×640) vẫn vừa, nhưng
 * s=2 cho **800×1280 = 1 024 000 px** và **1280×1280 = 1 638 400 px** — vượt level 3.1, nên
 * `isConfigSupported` trả `false` ⇒ exporter **lặng lẽ rơi về đường PNG**, 3600 PNG × 143 KB ≈ 515 MB,
 * upload chết. Đo thật bằng `sim3d/tools/probe_codec.mjs`:
 *
 * | kích thước | px | codec được hỗ trợ |
 * |---|---|---|
 * | 400×640 | 256 000 | 42E01F (3.1) … |
 * | 640×640 | 409 600 | 42E01F (3.1) … |
 * | 800×1280 | 1 024 000 | **42E020 (3.2)** trở lên — *không* có 3.1 |
 * | 1280×1280 | 1 638 400 | **42E028 (4.0)** trở lên |
 *
 * Vì vậy level được suy ra từ `width × height`, giữ nguyên baseline profile.
 */
export const H264_CONFIG = {
  /** Codec cho ảnh ≤ level 3.1 (921 600 px) — mọi cỡ ở s=1. */
  codec: 'avc1.42E01F',
  /** bitrate theo số pixel: 4 Mbps cho 640×640, giảm/tăng theo diện tích. */
  baseBitrate: 4_000_000,
  basePixels: 640 * 640,
  /** Keyframe 50 frame = 2 s o 25 fps (mediabunny tinh bang GIAY). */
  keyFrameIntervalSeconds: 50 / 25,
  /** So frame giua hai keyframe. */
  keyFrameEveryFrames: 50,
  /**
   * Bảng level theo `MaxFS` của H.264 (macroblock 16×16, tối đa `MaxFS × 256` pixel).
   * Cùng profile Baseline (`42`), chỉ khác byte level — mọi trình duyệt hỗ trợ H.264 đều có.
   */
  levels: [
    { maxPixels: 921_600, codec: 'avc1.42E01F' }, // level 3.1 — MaxFS 3600
    { maxPixels: 1_310_720, codec: 'avc1.42E020' }, // level 3.2 — MaxFS 5120
    { maxPixels: 2_097_152, codec: 'avc1.42E028' }, // level 4.0 — MaxFS 8192
    { maxPixels: 5_652_480, codec: 'avc1.42E032' }, // level 5.0 — MaxFS 22080
  ],
} as const;

/**
 * Codec H.264 phù hợp cho một kích thước ảnh.
 *
 * Ném lỗi khi ảnh vượt cả level 5.0 thay vì trả codec sai — thà fail rõ còn hơn để
 * `isConfigSupported` trả `false` rồi exporter âm thầm chuyển sang PNG (đã từng xảy ra, xem trên).
 */
export function codecFor(width: number, height: number): string {
  const pixels = width * height;
  for (const level of H264_CONFIG.levels) {
    if (pixels <= level.maxPixels) {
      return level.codec;
    }
  }
  throw new ExportError(
    'config',
    `codecFor: ${String(width)}×${String(height)} = ${String(pixels)} px vượt H.264 level 5.0 ` +
      `(${String(H264_CONFIG.levels[H264_CONFIG.levels.length - 1].maxPixels)} px); giảm hệ số phóng ảnh`,
  );
}

/** Bitrate cho một kích thước (giữ tỉ lệ bit/pixel của 640×640). */
export function bitrateFor(width: number, height: number): number {
  const ratio = (width * height) / H264_CONFIG.basePixels;
  return Math.max(1_000_000, Math.round(H264_CONFIG.baseBitrate * ratio));
}

/** Kiểm trình duyệt có mã hoá được H.264 ở kích thước này không (D12). */
export async function isEncoderSupported(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: codecFor(width, height),
      width,
      height,
      bitrate: bitrateFor(width, height),
      framerate: EXPORT_FPS,
    });
    return support.supported === true;
  } catch (error) {
    // Trình duyệt không hiểu codec ⇒ coi như không hỗ trợ (không phải lỗi lập trình).
    console.warn('isEncoderSupported: trình duyệt từ chối cấu hình', error);
    return false;
  }
}

/** Lấy bề mặt vẽ được từ `FrameSurface` (canvas thật trong trình duyệt). */
function canvasOf(surface: FrameSurface): HTMLCanvasElement | OffscreenCanvas {
  const candidate = surface as unknown as {
    canvas?: HTMLCanvasElement | OffscreenCanvas;
  };
  if (candidate.canvas === undefined) {
    throw new ExportError(
      'encoder',
      'FrameSurface thiếu `.canvas` — encoder WebCodecs cần canvas để đọc frame',
    );
  }
  return candidate.canvas;
}

/**
 * Tạo encoder MP4 bằng WebCodecs + mediabunny cho một kích thước.
 *
 * Trả `null` khi trình duyệt không hỗ trợ H.264 ở kích thước đó (⇒ `runExport` dùng PNG).
 */
export async function createWebCodecsEncoder(
  width: number,
  height: number,
  /** Có sink ⇒ đẩy MP4 lên BE theo khúc (RAM ~hằng số, P17n); không có ⇒ giữ cả file trong RAM. */
  sink: VideoSink | null = null,
): Promise<FrameEncoder | null> {
  if (!(await isEncoderSupported(width, height))) {
    return null;
  }

  // Ghi dòng: mediabunny phát `{ data, position }`; ta chờ BE nhận xong từng khúc (áp lực ngược).
  const target =
    sink === null
      ? new BufferTarget()
      : new StreamTarget(
          new WritableStream({
            write: async (chunk) => {
              // Sao chép: mediabunny có thể tái dùng bộ đệm sau khi Promise xong.
              await sink.write(new Uint8Array(chunk.data), chunk.position);
            },
          }),
          { chunked: true, chunkSize: STREAM_CHUNK_BYTES },
        );
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new VideoSampleSource({
    codec: 'avc',
    bitrate: bitrateFor(width, height),
    keyFrameInterval: H264_CONFIG.keyFrameIntervalSeconds,
  });
  output.addVideoTrack(source, { frameRate: EXPORT_FPS });

  let started = false;
  let closed = false;

  const ensureStarted = async (): Promise<void> => {
    if (!started) {
      await output.start();
      started = true;
    }
  };

  const fail = (message: string, cause: unknown): never => {
    throw new ExportError('encoder', message, cause);
  };

  return {
    streamed: sink !== null,
    addFrame: async (frame, surface, timestampUs) => {
      if (closed) {
        fail(`addFrame sau khi đã đóng (frame ${String(frame)})`, null);
      }
      await ensureStarted();
      try {
        const canvas = canvasOf(surface);
        // `mediabunny` dùng **giây** cho timestamp/duration (không phải µs như WebCodecs).
        const sample = new VideoSample(canvas, {
          timestamp: timestampUs / 1_000_000,
          duration: 1 / EXPORT_FPS,
        });
        await source.add(sample, { keyFrame: frame % H264_CONFIG.keyFrameEveryFrames === 0 });
        sample.close();
      } catch (error) {
        fail(
          `Mã hoá frame ${String(frame)} thất bại: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },

    finish: async () => {
      if (closed) {
        return null;
      }
      closed = true;
      try {
        await ensureStarted();
        await output.finalize();
        if (sink !== null) {
          // Mọi khúc đã lên BE (finalize chờ WritableStream đóng); đổi tên `.part` -> file thật.
          await sink.commit();
          return null;
        }
        const buffer = (target as BufferTarget).buffer;
        if (buffer === null || buffer === undefined) {
          return null;
        }
        return new Uint8Array(new Uint8Array(buffer));
      } catch (error) {
        return fail(
          `Kết thúc encoder thất bại: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },

    abort: async () => {
      if (closed) {
        return;
      }
      closed = true;
      // Không gọi `finalize()`: bỏ dở để không tạo mp4 thiếu frame (D12).
      // `Output.cancel()` giải phóng encoder/bộ đệm; lỗi dọn dẹp chỉ cảnh báo,
      // không che lỗi gốc mà `runExport` đang ném.
      try {
        await output.cancel();
      } catch (error) {
        console.warn('webCodecsEncoder.abort: Output.cancel lỗi', error);
      }
    },
  };
}

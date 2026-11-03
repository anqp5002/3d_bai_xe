/**
 * Lớp xuất video (FE §7, C1, C12, D12) — vòng render offline, encoder, đóng gói file.
 *
 * Điểm vào:
 * - `runExport()` (`./runExport`) — vòng xuất đầy đủ, tiêm phụ thuộc nên test được.
 * - `buildTechgarConfig()` (`./techgarBundle`) — bộ `techgar_config/` cho TechGAR.
 * - `createWebCodecsEncoder()` (`./webCodecsEncoder`) — encoder H.264 thật trong trình duyệt.
 *
 * File này chỉ giữ hằng số dùng chung; không còn hàm giả "chưa cài đặt" từ P1.
 */

/** Số frame đánh dấu đồng bộ ở đầu video quay màn hình (C2). */
export const SYNC_LEADER_FRAMES = 3;

/** FPS cố định của mọi video xuất ra (BE §4.2). */
export const EXPORT_FPS = 25;

/** Lỗi của lớp xuất. */
export class ExportError extends Error {
  override readonly name = 'ExportError';
}

export { runExport, fileNameFor, realtimeRatio, renderFps, validateOutputs } from './runExport';
export type {
  ExportBackend,
  ExportLog,
  ExportOptions,
  ExportOutput,
  ExportProgress,
  ExportResult,
  FrameEncoder,
  FrameRenderer,
  FrameSurface,
  PauseGate,
  SimSource,
} from './runExport';
export { buildTechgarConfig } from './techgarBundle';

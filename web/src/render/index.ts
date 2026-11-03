/**
 * Lớp render (FE §6) — Three.js đọc trạng thái mô phỏng, dựng cảnh, môi trường, nhiễu.
 *
 * P1: chưa cài đặt. Mọi hàm ở đây ném lỗi rõ ràng thay vì trả cảnh giả (R2).
 */

/** Hằng số khung hình dùng chung cho render và xuất (U19). */
export const FRAME_SIZE_PX = 640;
/** Kích thước một khung camera khi tách cam1/cam2 (U19). */
export const CAMERA_FRAME_WIDTH_PX = 400;
/** Vị trí cắt cam2 trên khung 640 (U19). */
export const CAM2_CROP_X = 240;

/** Lỗi của lớp render. */
export class RenderError extends Error {
  override readonly name = 'RenderError';
}

/** Tạo cảnh Three.js từ bãi + trạng thái — P4. */
export function createScene(): never {
  throw new RenderError('createScene: chưa cài đặt (P4)');
}

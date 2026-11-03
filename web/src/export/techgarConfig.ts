/**
 * Sinh bộ config TechGAR từ `lot` (BE §5, U16, D2, D3; G0 đã chốt trong `ANS_1.md` mục A).
 *
 * **Hàm thuần**: chỉ đọc `lot` + tham số, trả về chuỗi JSON/text cho từng file. Không
 * `fetch`, không DOM, không đọc file — nên test bằng Node được và BE không phải tính lại.
 *
 * G0 (ANS_1 A.1–A.4) — những điểm **thắng** mọi chỗ khác:
 * 1. Khung **400×640** cho cam1/cam2 (không dùng 1280×720 của session mẫu).
 * 2. `calibration.json` **không** có `source.capture_manifest` (có thì TechGAR kiểm tỉ lệ
 *    16:9 và `raise` với 400×640 — xem `REPORT_P0` mục (b)).
 * 3. `k = 5,116 / (bề rộng ô trung vị sau chuẩn hoá, m)`; kiểm chéo `9,249 / k` phải ra
 *    chiều sâu ô ±20 %, lệch hơn thì **ném lỗi** (không im lặng).
 * 4. `tracking_defaults`/`matching_defaults` **chép nguyên** từ session mẫu toi1.
 *
 * Nguồn số của session mẫu (đọc để lấy giá trị, không import từ `backend/`):
 * `backend/main_detect/config/sessions/droidcam_shared_toi1/calibration.json`
 * (`snapshot 2026-09-17`, `schema_version 5`, `calibration_status: passed`).
 */

import type { LotMap, Slot, Vec2 } from '../contracts/lot';
/**
 * Cạnh ngắn trung vị của ô trong `parking_slots_world` của session toi1, đơn vị world.
 * Đo lại bằng `cv2.minAreaRect` trên 60 polygon (30 cam1 + 30 cam2) — `REPORT_P0` mục (g).
 */
export const SAMPLE_SLOT_SHORT_MEDIAN = 5.116;

/**
 * Cạnh dài trung vị cùng bộ (dùng để kiểm chéo `9,249 / k` ≈ chiều sâu ô PUCPR).
 * `REPORT_P0` (g): 9.249 là số mà `median_slot_length` của TechGAR lấy (max của rect).
 */
export const SAMPLE_SLOT_LONG_MEDIAN = 9.249;

/** Đơn vị world của TechGAR (file ghi "cm" nhưng là cm trên bãi mô hình thu nhỏ — D2). */
export const WORLD_UNIT = 'cm';

/** Kích thước ảnh **gốc** của một khung cam sau cắt (U19, G0): 400×640. */
export const TECHGAR_IMAGE = { width: 400, height: 640 } as const;

/**
 * Hệ số phóng ảnh cam khi xuất cho TechGAR (BRIEF_P15 mục A).
 *
 * **Vì sao cần:** bộ dò chuyển động của TechGAR được chỉnh cho ảnh thật **1280×720**
 * (`motion_tracker.py` ghim `min_width=22`, `min_height=18`, `min_area=650`,
 * `motion_min_pixels=160`, không có cờ CLI). Xe trong sim ở 400×640 chỉ ~42×22 px nên đối
 * tượng chuyển động quá nhỏ — đo thực tế chỉ phát hiện **24 % / 5 %** xe-frame đang chạy
 * (cam1/cam2, `recall_probe.py` trên run đêm mưa).
 *
 * **Chọn s theo số đo** (REPORT_P15a bước 1): bbox xe thật trong session
 * `reidfix_r0b_session_thai8` có trung vị **65×76 px**; xe sim ở s=1 là **42×22 px**.
 * s = 2 cho **84×44 px** (75 % diện tích xe thật) và tổng 800×1280 = 1,02 Mpx ≈ 1280×720
 * (0,92 Mpx), tức TechGAR chạy nặng tương đương ngoài đời. Recall sau khi áp s=2:
 * **78 % / 58 %** (mask cũ) và **83 % / 70 %** (mask mới) — xem REPORT_P15a.
 */
export const TECHGAR_SCALE = 2;

/** Kích thước ảnh cam **sau** khi nhân hệ số `s` (mặc định `s=2` → 800×1280). */
export function techgarImageSize(scale: number = TECHGAR_SCALE): {
  readonly width: number;
  readonly height: number;
} {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TechgarConfigError(`techgarImageSize: hệ số phải > 0, nhận ${String(scale)}`);
  }
  return {
    width: Math.round(TECHGAR_IMAGE.width * scale),
    height: Math.round(TECHGAR_IMAGE.height * scale),
  };
}

/** Sai số cho phép khi kiểm chéo `9,249 / k` so với chiều sâu ô (D2/G0). */
export const DEPTH_CHECK_TOLERANCE = 0.2;

/** Tỉ lệ diện tích đa giác ô phải nằm trong khung cam để ô thuộc cam đó (BE §5). */
export const CAM_MEMBERSHIP_RATIO = 0.8;

/**
 * `tracking_defaults` chép nguyên từ session mẫu toi1
 * (`calibration.json` → `tracking_defaults`). Không suy diễn thêm.
 */
export const SAMPLE_TRACKING_DEFAULTS = { shared_map_anchor: 'bbox_center' } as const;

/**
 * `matching_defaults` chép nguyên từ session mẫu toi1. Các khoảng cách tính bằng **world
 * unit** (đã co theo `k`), nên giữ nguyên số là đúng tỉ lệ (D2).
 */
export const SAMPLE_MATCHING_DEFAULTS = {
  unit: WORLD_UNIT,
  handoff_match_distance: 15.0,
  handoff_prediction_radius: 25.0,
  dormant_match_distance: 35.0,
  cross_camera_duplicate_distance: 9.0,
} as const;

/** Lỗi sinh config TechGAR; thông điệp phải nói rõ sai ở đâu (R2). */
export class TechgarConfigError extends Error {
  override readonly name = 'TechgarConfigError';
}

/** Làm tròn 4 chữ số cho JSON ổn định. */
export function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Một file trong `techgar_config/`: đường dẫn tương đối + nội dung. */
export interface ConfigFile {
  /** Đường dẫn trong `data/runs/<run_id>/techgar_config/`, ví dụ `calibration.json`. */
  readonly path: string;
  /** Nội dung UTF-8. */
  readonly text: string;
}

/** Kết quả sinh config. */
export interface TechgarConfigBundle {
  readonly files: readonly ConfigFile[];
  /** Hệ số k đã dùng (ghi vào MANIFEST + REPORT). */
  readonly k: number;
  /** Chiều sâu ô trung vị dùng để kiểm chéo, m. */
  readonly slotDepthM: number;
  /** `9,249 / k` — chiều sâu suy ra từ cạnh dài session mẫu, m. */
  readonly impliedDepthM: number;
  /** Sai lệch tương đối giữa `impliedDepthM` và `slotDepthM` (≤ 0,2 là đạt). */
  readonly depthError: number;
}

// --------------------------------------------------------------------------------------
// Hình học: mét → world unit của TechGAR
// --------------------------------------------------------------------------------------
/** Median của một dãy số; ném lỗi nếu rỗng (R2). */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new TechgarConfigError('median: dãy rỗng');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Bề rộng ô trung vị của bãi (m) — dùng làm mẫu số của `k` (G0 A.3). */
export function medianSlotWidthM(lot: LotMap): number {
  if (lot.slots.length === 0) {
    throw new TechgarConfigError('medianSlotWidthM: lot không có ô nào');
  }
  return median(lot.slots.map((slot) => slot.width_m));
}

/** Chiều sâu ô trung vị (m), đo từ đa giác (cạnh dài của hình chữ nhật). */
export function medianSlotDepthM(lot: LotMap): number {
  if (lot.slots.length === 0) {
    throw new TechgarConfigError('medianSlotDepthM: lot không có ô nào');
  }
  return median(lot.slots.map((slot) => slotDepth(slot)));
}

/**
 * Chiều sâu một ô (m) = **cạnh dài** của đa giác.
 *
 * P2b chuẩn hoá đa giác theo thứ tự `(trước-trái, trước-phải, sau-phải, sau-trái)`, nên
 * cạnh dài là cạnh thứ 2 (giữa đỉnh 1 và 2), không phải cạnh 0→1. Lấy max cho chắc.
 */
export function slotDepth(slot: Slot): number {
  const [a, b, c] = slot.polygon;
  const first = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const second = Math.hypot(c[0] - b[0], c[1] - b[1]);
  return Math.max(first, second);
}

/**
 * Hệ số `k` (world unit / mét) theo G0 A.3.
 *
 * `k = 5,116 / (bề rộng ô trung vị, m)`. Nhờ vậy bề rộng ô PUCPR biểu diễn bằng đúng
 * cạnh ngắn trung vị của session mẫu, và `matching_defaults` giữ nguyên số vẫn đúng tỉ lệ.
 */
export function computeK(lot: LotMap): number {
  const widthM = medianSlotWidthM(lot);
  if (!(widthM > 0)) {
    throw new TechgarConfigError(`computeK: bề rộng ô trung vị phải > 0, nhận ${String(widthM)}`);
  }
  return SAMPLE_SLOT_SHORT_MEDIAN / widthM;
}

/**
 * Kiểm chéo G0 A.3: `9,249 / k` phải ra chiều sâu ô ±20 %.
 * Lệch hơn ⇒ ném lỗi rõ ràng (không im lặng), kèm cả 3 số để người đọc thấy ngay.
 */
export function checkDepthConsistency(k: number, depthM: number): { implied: number; error: number } {
  const implied = SAMPLE_SLOT_LONG_MEDIAN / k;
  const error = Math.abs(implied - depthM) / depthM;
  if (error > DEPTH_CHECK_TOLERANCE) {
    throw new TechgarConfigError(
      `Kiểm chéo G0 A.3 thất bại: 9,249 / k = ${implied.toFixed(3)} m nhưng chiều sâu ô ` +
        `trung vị là ${depthM.toFixed(3)} m (lệch ${(error * 100).toFixed(1)} % > ` +
        `${String(DEPTH_CHECK_TOLERANCE * 100)} %). k = ${k.toFixed(6)} world unit/m.`,
    );
  }
  return { implied, error };
}

/** Đổi điểm world (m) sang world unit của TechGAR, gốc tại tâm bãi. */
export function toTechgarPoint(point: Vec2, origin: Vec2, k: number): Vec2 {
  return [(point[0] - origin[0]) * k, (point[1] - origin[1]) * k];
}

/** Tâm khung bao của mọi ô �� dùng làm gốc toạ độ world unit. */
export function lotCenter(lot: LotMap): Vec2 {
  if (lot.slots.length === 0) {
    throw new TechgarConfigError('lotCenter: lot không có ô nào');
  }
  const xs = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[0]));
  const ys = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[1]));
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** Khung bao mọi ô (m) → `world.bounds` (world unit), đúng khoá của session mẫu. */
export function boundsOf(lot: LotMap, origin: Vec2, k: number): {
  min_x_cm: number;
  min_y_cm: number;
  max_x_cm: number;
  max_y_cm: number;
} {
  const xs = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[0]));
  const ys = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[1]));
  return {
    min_x_cm: round((Math.min(...xs) - origin[0]) * k),
    min_y_cm: round((Math.min(...ys) - origin[1]) * k),
    max_x_cm: round((Math.max(...xs) - origin[0]) * k),
    max_y_cm: round((Math.max(...ys) - origin[1]) * k),
  };
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

// --------------------------------------------------------------------------------------
// Homography: ảnh (u, v) → world unit, dựng từ công thức `project()`
// --------------------------------------------------------------------------------------
/**
 * `ground()` của bộ cũ: điểm ảnh (u, v) trên khung 640 → toạ độ world (X, Y) mét.
 * Nguyên văn `docs/pklot_video/blender/build_blender_video.py:48-53` (nguồn sự thật hình học).
 */
export function groundPoint(
  camera: { pitch_deg: number; f_px: number; height_m: number },
  u: number,
  v: number,
): Vec2 {
  const pitch = (camera.pitch_deg * Math.PI) / 180;
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const t = (v - 320) / camera.f_px;
  const denominator = t * cos + sin;
  if (Math.abs(denominator) < 1e-12) {
    throw new TechgarConfigError(
      `groundPoint: v = ${String(v)} nằm trên đường chân trời, không chiếu xuống được`,
    );
  }
  const y = (camera.height_m * (cos - t * sin)) / denominator;
  const z = y * cos + camera.height_m * sin;
  return [((u - 320) * z) / camera.f_px, y];
}

/**
 * Homography 3×3 ảnh(640) → **world unit** của TechGAR, dựng từ 4 góc khung.
 *
 * `project()` là một phép chiếu phối cảnh của mặt phẳng `Y = 0`, nên nghịch đảo của nó là
 * homography **chính xác**; `ground()` chính là nghịch đảo đó. Dựng homography từ 4 điểm
 * (góc khung, chiếu bằng `ground()`) là cách chắc chắn nhất — không phải tự suy ma trận.
 *
 * @param cropU0 cột bắt đầu của khung cam trên ảnh 640 (cam1 = 0, cam2 = 240).
 */
export function imageToWorldHomography(
  camera: { pitch_deg: number; f_px: number; height_m: number; res: readonly [number, number] },
  cropU0: number,
  origin: Vec2,
  k: number,
  /**
   * Hệ số phóng ảnh cam (BRIEF_P15). Homography nhận **pixel của ảnh đã phóng**, nên 4 góc
   * nguồn dùng `cropWidth × scale`, còn điểm thế giới vẫn tính từ pixel **gốc** (`/ scale`).
   */
  scale = 1,
): readonly (readonly [number, number, number])[] {
  const [width, height] = camera.res;
  const cropWidth = TECHGAR_IMAGE.width;
  if (cropU0 < 0 || cropU0 + cropWidth > width) {
    throw new TechgarConfigError(
      `imageToWorldHomography: vùng cắt [${String(cropU0)}, ${String(cropU0 + cropWidth)}] ` +
        `vượt khung ${String(width)}`,
    );
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TechgarConfigError(
      `imageToWorldHomography: hệ số phải > 0, nhận ${String(scale)}`,
    );
  }
  // 4 góc của khung đã cắt, ở **toạ độ ảnh đã phóng**.
  const cornersPx: readonly Vec2[] = [
    [0, 0],
    [cropWidth * scale, 0],
    [cropWidth * scale, height * scale],
    [0, height * scale],
  ];
  const src = cornersPx.map(([x, y]) => [x, y] as Vec2);
  const dst = cornersPx.map(([x, y]) => {
    // Đổi về pixel **gốc** rồi mới chiếu xuống mặt đất (công thức `ground()` dùng px gốc).
    const world = groundPoint(camera, x / scale + cropU0, y / scale);
    return toTechgarPoint(world, origin, k);
  });
  return homographyFromFourPoints(src, dst);
}

/**
 * Homography 3×3 từ 4 cặp điểm (DLT 8 ẩn, giải bằng khử Gauss).
 *
 * Dùng để dựng `camera_transforms`: lấy 4 điểm ảnh ở góc khung, chiếu ngược bằng
 * `ground()` của công thức camera (nguồn sự thật), rồi giải homography. Vì `ground()` là
 * nghịch đảo chính xác của `project()` trên mặt phẳng `Y = 0`, homography dựng từ 4 điểm
 * khớp **chính xác** mọi điểm khác (kiểm trong test).
 */
export function homographyFromFourPoints(
  src: readonly Vec2[],
  dst: readonly Vec2[],
): readonly (readonly [number, number, number])[] {
  if (src.length !== 4 || dst.length !== 4) {
    throw new TechgarConfigError(
      `homographyFromFourPoints: cần đúng 4 cặp điểm, nhận ${String(src.length)}/${String(dst.length)}`,
    );
  }
  // 8 phương trình cho 8 ẩn (h11..h32, h33 = 1).
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = src[index];
    const [u, v] = dst[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const solution = solveLinearSystem(rows);
  return [
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1],
  ];
}

/** Giải hệ tuyến tính n×n bằng khử Gauss có chọn trục; ném lỗi nếu suy biến. */
export function solveLinearSystem(rows: readonly (readonly number[])[]): readonly number[] {
  const n = rows.length;
  if (n === 0 || rows.some((row) => row.length !== n + 1)) {
    throw new TechgarConfigError(
      `solveLinearSystem: cần ma trận n×(n+1), nhận ${String(n)} hàng với độ dài khác nhau`,
    );
  }
  const a = rows.map((row) => [...row]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      throw new TechgarConfigError(
        `solveLinearSystem: ma trận suy biến tại cột ${String(col)} (pivot ≈ 0)`,
      );
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let k = col; k <= n; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row][n];
    for (let col = row + 1; col < n; col += 1) {
      sum -= a[row][col] * solution[col];
    }
    solution[row] = sum / a[row][row];
  }
  return solution;
}

/** Áp homography 3×3 lên một điểm (chia cho toạ độ thuần nhất thứ ba). */
export function applyHomography(
  matrix: readonly (readonly [number, number, number])[],
  point: Vec2,
): Vec2 {
  const [x, y] = point;
  const denominator = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
  if (Math.abs(denominator) < 1e-12) {
    throw new TechgarConfigError('applyHomography: điểm ở vô cực (mẫu số ≈ 0)');
  }
  return [
    (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / denominator,
    (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / denominator,
  ];
}

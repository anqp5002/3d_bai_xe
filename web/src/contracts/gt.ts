/**
 * Contract C-A — ground truth (FE §4.6, C9, D10; MEGAPLAN bảng C-A).
 *
 * GT là **trạng thái thật của mô phỏng**, không phụ thuộc render, môi trường hay nhiễu
 * (ý tưởng §5). Tên cột giữ đúng bộ cũ (`docs/pklot_video/ds/gen_dataset.py:497-533`)
 * và thêm phần mở rộng ở **cuối** theo D10 / FE §4.6.
 */

import type { CarColor, CarModel } from './sim';
import type { SlotId } from './lot';

/** Nhãn camera mà tâm xe rơi vào (FE §4.6). Rỗng = không nằm trong khung nào. */
export const CAM_TAGS = ['cam1', 'cam2', 'cam1+cam2', ''] as const;
export type CamTag = (typeof CAM_TAGS)[number];

/** Cột cố định đầu `gt_frames.csv`: `frame` + 100 cột ô theo thứ tự S001…S100. */
export const GT_FRAME_PREFIX_COLUMNS = ['frame'] as const;

/** Giá trị một ô trong GT: 0/1 (D10, C9). */
export type SlotOccupancy = 0 | 1;

/** Phần chiếu của một xe trong frame. Vắng mặt (xe chưa có / đã ra) thì ô CSV để trống. */
export interface GtCarProjection {
  /** Tâm xe chiếu ra ảnh 640, px, 1 chữ số thập phân; `null` = không có trong frame. */
  readonly u: number | null;
  readonly v: number | null;
  readonly cams: CamTag;
}

/**
 * Một dòng `gt_frames.csv`.
 *
 * Thứ tự cột khi ghi file: `frame`, `S001`…`S100`, rồi với **mỗi xe từng xuất hiện**
 * (theo thứ tự tạo): `<car>_u`, `<car>_v`, `<car>_cams`.
 */
export interface GtFrameRow {
  readonly frame: number;
  readonly occupancy: Readonly<Record<SlotId, SlotOccupancy>>;
  /** Khoá = mã xe (V001…). Xe không có mặt trong frame thì không có khoá. */
  readonly cars: Readonly<Record<string, GtCarProjection>>;
}

/**
 * Một dòng `gt_events.csv` (FE §4.6 + D10).
 *
 * Thứ tự cột: `car, slot, gate_in_frame, parked_frame, depart_frame,
 * cam2_to_cam1_overlap_enter, gate_out_frame, arrival_crosses_cameras`,
 * rồi phần mở rộng ở cuối: `initial_parked, model, color, speed_kmh`.
 *
 * Frame nào không xảy ra (xe đỗ sẵn không qua cổng) thì để `null` → CSV ghi ô trống.
 */
export interface GtEventRow {
  readonly car: string;
  /** `null` = xe chỉ đi qua chứ không đỗ (không xảy ra với PUCPR hiện tại). */
  readonly slot: SlotId | null;
  /** D10: frame đầu tâm xe vượt đoạn cổng vào, tính theo world (không theo u). */
  readonly gate_in_frame: number | null;
  /** Frame tâm xe nằm trong đa giác ô đích (C9). */
  readonly parked_frame: number | null;
  /** Frame bắt đầu rời ô. */
  readonly depart_frame: number | null;
  /**
   * Frame đầu tiên sau `depart_frame` mà tâm xe có u < 400
   * (vào vùng chồng lấn cam1/cam2 khi đi về tây).
   */
  readonly cam2_to_cam1_overlap_enter: number | null;
  /** D10: frame đầu tâm xe vượt đoạn cổng ra, theo world. */
  readonly gate_out_frame: number | null;
  /** Trên đường vào bãi, xe có đi qua vùng chỉ cam2 thấy không (u < 240). */
  readonly arrival_crosses_cameras: 0 | 1;
  /** Phần mở rộng (FE §4.6): xe có đỗ sẵn từ frame 0 không. */
  readonly initial_parked: 0 | 1;
  readonly model: CarModel;
  readonly color: CarColor;
  readonly speed_kmh: number;
  /**
   * Lý do xe **không** được tính đếm cổng (P11c mục 2, ANS_17).
   *
   * Rỗng = xe bình thường, `gate_in_frame`/`gate_out_frame` có nghĩa.
   * Có giá trị = hai cột đó **rỗng theo thiết kế**, vì:
   * - `before_count_line`: xe tới ô trước khi cắt vạch đếm;
   * - `camera_blind_A3`: lộ trình đi qua A3, camera không phủ quanh `x = ±20`;
   * - `route_not_on_A2`: lột trình cắt vạch 0 hoặc ≥ 2 lần (thường do đi vòng qua tâm bãi).
   *
   * `verify.py` mục 3 bỏ qua thứ tự cổng cho xe có cờ (các mục khác vẫn kiểm).
   */
  readonly gate_note: GateNote | null;
}

/** Lý do một xe không được tính đếm cổng (P11c mục 2). */
export const GATE_NOTES = ['before_count_line', 'camera_blind_A3', 'route_not_on_A2'] as const;
export type GateNote = (typeof GATE_NOTES)[number];

/** Giá trị cột của một dòng sự kiện, đúng thứ tự ghi file. */
export const GT_EVENT_COLUMNS = [
  'car',
  'slot',
  'gate_in_frame',
  'parked_frame',
  'depart_frame',
  'cam2_to_cam1_overlap_enter',
  'gate_out_frame',
  'arrival_crosses_cameras',
  'initial_parked',
  'model',
  'color',
  'speed_kmh',
  'gate_note',
] as const;

export type GtEventColumn = (typeof GT_EVENT_COLUMNS)[number];

/**
 * Một dòng `frame_timestamps.csv` (giống bộ cũ: `gen_dataset.py:474-475`).
 * `frame_idx` bắt đầu từ 1; ns = 1e12 + (frame_idx − 1) × 40 000 000.
 */
export interface FrameTimestampRow {
  readonly frame_idx: number;
  readonly cam1_monotonic_ns: number;
  readonly cam2_monotonic_ns: number;
}

/** Cột của `frame_timestamps.csv`, đúng thứ tự. */
export const FRAME_TIMESTAMP_COLUMNS = [
  'frame_idx',
  'cam1_monotonic_ns',
  'cam2_monotonic_ns',
] as const;

/** Hằng số gốc thời gian của bộ cũ: 1e12 ns. */
export const TIMESTAMP_BASE_NS = 1_000_000_000_000;
/** 40 ms = 1 frame ở 25 fps, tính bằng ns. */
export const TIMESTAMP_STEP_NS = 40_000_000;

/**
 * Dựng dòng `frame_timestamps.csv` cho frame 0-based của mô phỏng.
 * FE §4.6: `frame_idx` bắt đầu từ 1 nên frame 0 → 1.
 */
export function frameTimestampRow(frame: number): FrameTimestampRow {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`frameTimestampRow: frame phải là số nguyên ≥ 0, nhận ${frame}`);
  }
  const ns = TIMESTAMP_BASE_NS + frame * TIMESTAMP_STEP_NS;
  return { frame_idx: frame + 1, cam1_monotonic_ns: ns, cam2_monotonic_ns: ns };
}

/** Cột của một xe trong `gt_frames.csv` (thứ tự cố định trong một dòng). */
export function carFrameColumns(carId: string): readonly [string, string, string] {
  return [`${carId}_u`, `${carId}_v`, `${carId}_cams`] as const;
}

/** Header đầy đủ của `gt_frames.csv` theo danh sách xe đã từng xuất hiện. */
export function gtFrameHeader(slotIds: readonly SlotId[], carIds: readonly string[]): string[] {
  return [
    ...GT_FRAME_PREFIX_COLUMNS,
    ...slotIds,
    ...carIds.flatMap((carId) => [...carFrameColumns(carId)]),
  ];
}

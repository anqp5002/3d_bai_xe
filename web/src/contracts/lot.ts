/**
 * Contract C-A — bản đồ bãi (FE §3, ý tưởng §8, D5, D6).
 *
 * Đơn vị: **mét**, hệ tọa độ world của `ground()` (X sang phải, Y ra xa camera).
 * Ảnh: 640×640 px, cam1 = x 0–400, cam2 = x 240–640 (U19).
 */

/** Điểm trong world, mét. */
export type Vec2 = readonly [x: number, y: number];

/** Điểm trên ảnh 640×640, px. */
export type Vec2Px = readonly [u: number, v: number];

/**
 * Mã ô chuẩn: S001…S100, đúng thứ tự `sample_spaces.csv` (ý tưởng §8).
 * Danh sách là nguồn sự thật duy nhất — mọi `Record<SlotId, …>` đều bắt buộc đủ 100 khoá.
 */
export const SLOT_IDS = [
  'S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008', 'S009', 'S010',
  'S011', 'S012', 'S013', 'S014', 'S015', 'S016', 'S017', 'S018', 'S019', 'S020',
  'S021', 'S022', 'S023', 'S024', 'S025', 'S026', 'S027', 'S028', 'S029', 'S030',
  'S031', 'S032', 'S033', 'S034', 'S035', 'S036', 'S037', 'S038', 'S039', 'S040',
  'S041', 'S042', 'S043', 'S044', 'S045', 'S046', 'S047', 'S048', 'S049', 'S050',
  'S051', 'S052', 'S053', 'S054', 'S055', 'S056', 'S057', 'S058', 'S059', 'S060',
  'S061', 'S062', 'S063', 'S064', 'S065', 'S066', 'S067', 'S068', 'S069', 'S070',
  'S071', 'S072', 'S073', 'S074', 'S075', 'S076', 'S077', 'S078', 'S079', 'S080',
  'S081', 'S082', 'S083', 'S084', 'S085', 'S086', 'S087', 'S088', 'S089', 'S090',
  'S091', 'S092', 'S093', 'S094', 'S095', 'S096', 'S097', 'S098', 'S099', 'S100',
] as const;

export type SlotId = (typeof SLOT_IDS)[number];

/** Số ô của bãi PUCPR (FE §3, B-E §6.2). */
export const SLOT_COUNT = SLOT_IDS.length;

const SLOT_ID_SET: ReadonlySet<string> = new Set<string>(SLOT_IDS);

export function isSlotId(value: string): value is SlotId {
  return SLOT_ID_SET.has(value);
}

/**
 * Ném lỗi nếu `value` không phải mã ô hợp lệ. R2: không im lặng bỏ qua dữ liệu sai.
 */
export function assertSlotId(value: string): SlotId {
  if (!isSlotId(value)) {
    throw new Error(`Mã ô không hợp lệ: "${value}" (phải là S001…S100)`);
  }
  return value;
}

/** Mã hàng (chữ cái hoặc số tuỳ builder chốt ở P2, ví dụ "1"…"5"). */
export type RowId = string;

/** Tham số camera dataset PKLot (ý tưởng §8; f = 288 px, cao 33,6 m, chúi 80°). */
export interface CameraModel {
  /** Góc chúi so với phương ngang, độ. */
  readonly pitch_deg: number;
  /** Tiêu cự ảnh, px (trên khung 640×640). */
  readonly f_px: number;
  /** Độ cao camera, m. */
  readonly height_m: number;
  /** Kích thước khung đầy đủ, px. */
  readonly res: readonly [width: number, height: number];
  /** Vùng cắt cam1 theo trục u, px (U19: [0, 400]). */
  readonly cam1_x: readonly [u0: number, u1: number];
  /** Vùng cắt cam2 theo trục u, px (U19: [240, 640]). */
  readonly cam2_x: readonly [u0: number, u1: number];
}

/** Một ô đỗ. Đa giác đã chuẩn hoá theo hàng (D5), không phải bbox thô của csv. */
export interface Slot {
  readonly id: SlotId;
  readonly row: RowId;
  /** Tâm ô, m. */
  readonly center: Vec2;
  /** Hướng mũi xe khi đỗ, rad (0 = +X, ngược chiều kim đồng hồ). */
  readonly heading: number;
  /** 4 góc theo thứ tự vòng, m. */
  readonly polygon: readonly [Vec2, Vec2, Vec2, Vec2];
  /** 4 góc tương ứng trên ảnh 640×640, px. */
  readonly polygon_px: readonly [Vec2Px, Vec2Px, Vec2Px, Vec2Px];
  /** Bề rộng ô (cạnh ngắn), m. */
  readonly width_m: number;
  /**
   * Đã lập được thao tác vào/ra hợp lệ chưa (FE §4.3).
   * P1: kiểu dữ liệu; P2 (lot) chốt giá trị; P4 hiện `false` trên UI và không cho chọn.
   */
  readonly reachable: boolean;
}

/** Lối đi một chiều (D6: không có làn hai chiều). */
export interface Aisle {
  readonly id: string;
  /** Đường tâm làn, m. */
  readonly polyline: readonly Vec2[];
  /** Bề rộng làn, m. */
  readonly width_m: number;
  /** D6: toàn bộ lối là một chiều. Giữ literal `true` để không ai lỡ tạo làn 2 chiều. */
  readonly oneway: true;
  /** P17l: lối nối cung ở giao lộ — đi được nhưng không dùng làm làn vào/ra ô. */
  readonly connector?: boolean;
}

/** Cổng vào/ra: đoạn thẳng trên mặt đất, kèm điểm sinh/biến mất ngoài khung (C8). */
export interface Gate {
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly p1_px: Vec2Px;
  readonly p2_px: Vec2Px;
  /** [x, y, θ] — nơi xe xuất hiện, ngoài khung hình. */
  readonly spawn: readonly [x: number, y: number, theta: number];
  /** Nơi xe biến mất khỏi mô phỏng. */
  readonly despawn: Vec2;
}

export interface Gates {
  readonly in: Gate;
  readonly out: Gate;
}

/** Trang trí mặt bãi (FE §3, ý tưởng §8): cỏ, bó vỉa, cây, cột đèn. */
export interface DecorTree {
  readonly pos: Vec2;
  readonly radius_m: number;
  readonly height_m: number;
  /** Loại cây (low-poly) do render chọn; dữ liệu chỉ cần phân biệt được. */
  readonly kind: string;
}

export interface DecorLamp {
  readonly pos: Vec2;
  readonly height_m: number;
  /** Có bật trong kịch bản đêm không (FE §6). */
  readonly night_light: boolean;
}

export interface Decor {
  /** Đa giác thảm cỏ, m. */
  readonly grass: readonly (readonly Vec2[])[];
  /** Dải bó vỉa (polyline tim), m. */
  readonly curbs: readonly (readonly Vec2[])[];
  /** Vùng nhựa đường (phần còn lại coi như cỏ). */
  readonly asphalt: readonly (readonly Vec2[])[];
  readonly trees: readonly DecorTree[];
  readonly lamps: readonly DecorLamp[];
}

/** Toàn bộ `lot_pucpr.json` (FE §3). */
export interface LotMap {
  /** Tên bãi, ví dụ "pucpr". Kịch bản tham chiếu bằng tên này. */
  readonly name: string;
  readonly camera: CameraModel;
  readonly slots: readonly Slot[];
  readonly aisles: readonly Aisle[];
  readonly gates: Gates;
  readonly decor: Decor;
}

/** Lấy ô theo mã; ném lỗi nếu không có (R2). */
export function findSlot(lot: LotMap, id: SlotId): Slot {
  const slot = lot.slots.find((candidate) => candidate.id === id);
  if (slot === undefined) {
    throw new Error(`Không có ô "${id}" trong bãi "${lot.name}"`);
  }
  return slot;
}

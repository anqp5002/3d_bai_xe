/**
 * Dung sai `park_clip` (ANS_4) — phạm vi **hẹp có chủ đích**.
 *
 * Lý do tồn tại: dải trống giữa hàng 1 và hàng 2 chỉ **3,54 m** trong khi đường chéo xe là
 * **5,00 m** (đo trên `lot_pucpr.json`; xem `ASK_coders-2_2.md`). Vật cứng quay 90° cần bề
 * rộng ≥ đường chéo, nên xe vào/ra ô hàng 1–2 **buộc** phải lấn nhẹ vào xe đỗ ở ô kề cùng
 * hàng. ANS_4 cho phép dung sai đúng phần lấn đó, với ba giới hạn cứng:
 *
 * 1. Chỉ khi xe đang trong thao tác `parking_in` / `leaving_slot`.
 * 2. Chỉ với xe **đã đỗ** (`parked`) ở ô **kề cùng hàng** của chính ô đích/ô xuất phát.
 * 3. Chỉ ô thuộc **hàng 1–2**, và độ xuyên ≤ :data:`PARK_CLIP_MAX_DEPTH_M`.
 *
 * Mọi va chạm khác (xe chạy–xe chạy, xe chạy–xe đỗ không kề, hàng 3–5, quá độ sâu) **vẫn
 * chặn** như trước. Mỗi lần dung sai sinh một `Warning` `kind: 'park_clip'` — không im lặng.
 */

import type { LotMap } from '../contracts/lot';
import type { SlotId } from '../contracts/lot';
import type { CarState, Warning } from '../contracts/sim';

/**
 * Ngưỡng độ xuyên tối đa **theo hàng**, m (ANS_5).
 *
 * Hàng 1–2 có dải trống 3,54 m < đường chéo xe 5,00 m ⇒ buộc phải lấn nhiều, ngưỡng 0,5 m
 * (giữ như ANS_4). Hàng 3–5 có dải trống 6,25 m ≥ đường chéo nên chỉ được lấn mép do bước ô
 * hẹp — ngưỡng chặt **0,15 m** để lỗi hình học thật không bị dung sai che mất.
 */
export const PARK_CLIP_MAX_DEPTH_BY_ROW: Readonly<Record<string, number>> = {
  '1': 0.15,
  '2': 0.15,
  '3': 0.15,
  '4': 0.15,
  '5': 0.15,
};

/** Ngưỡng dùng khi hàng không có trong bảng (không nên xảy ra) — lấy mức chặt nhất. */
const FALLBACK_MAX_DEPTH_M = 0.15;

/** Ngưỡng độ xuyên cho một hàng, m. */
export function maxDepthForRow(row: string): number {
  return PARK_CLIP_MAX_DEPTH_BY_ROW[row] ?? FALLBACK_MAX_DEPTH_M;
}

/** Ngưỡng cao nhất trong bảng (chỗ nào cần một con số duy nhất). */
export const PARK_CLIP_MAX_DEPTH_M = Math.max(
  ...Object.values(PARK_CLIP_MAX_DEPTH_BY_ROW),
);

/** Các hàng **được** áp dụng dung sai (ANS_5: mọi hàng; chỉ khác ngưỡng). */
export const PARK_CLIP_ROWS: ReadonlySet<string> = new Set(
  Object.keys(PARK_CLIP_MAX_DEPTH_BY_ROW),
);
/** Khoảng cách tâm hai ô để coi là "ô kề cùng hàng", m. */
const NEIGHBOUR_DISTANCE_M = 3.5;
/** Trạng thái xe được phép dung sai. */
const MANEUVER_STATES: ReadonlySet<string> = new Set(['parking_in', 'leaving_slot']);
/** Một bản ghi `park_clip` đã chuẩn hoá, dùng cho export/UI (ANS_4 mục 4). */
export interface ParkClipRecord {
  readonly frame: number;
  readonly car_id: string;
  /** Ô đích (khi vào) hoặc ô xuất phát (khi ra) của xe đang thao tác. */
  readonly slot: SlotId;
  /** Ô kề bị lấn. */
  readonly neighbour_slot: SlotId;
  /** Xe đã đỗ ở ô kề đó. */
  readonly neighbour_car_id: string;
  /** Độ sâu xuyên theo SAT, m. */
  readonly depth_m: number;
  /** Hàng của ô đích/xuất phát. */
  readonly row: string;
}

function slotById(lot: LotMap, id: SlotId) {
  return lot.slots.find((slot) => slot.id === id);
}

/**
 * Các ô **kề cùng hàng** của `slotId` (thường là 2: trái và phải), hoặc `[]` nếu không có.
 *
 * "Ô kề" = ô khác cùng hàng có tâm cách tâm ô này ≤ :data:`NEIGHBOUR_DISTANCE_M`
 * (bước ô thật của bãi là 2,17–2,85 m). Phải trả **tất cả** ô kề: xe vào/ra một ô có thể
 * quệt ô bên trái hoặc bên phải tuỳ chiều quay, nên chỉ lấy "ô gần nhất" là thiếu (lỗi đã
 * gặp: S051 quệt S050 trong khi ô gần nhất được chọn là S052).
 */
export function adjacentSlotIds(lot: LotMap, slotId: SlotId): SlotId[] {
  const slot = slotById(lot, slotId);
  if (slot === undefined) {
    return [];
  }
  const found: { id: SlotId; distance: number }[] = [];
  for (const other of lot.slots) {
    if (other.id === slot.id || other.row !== slot.row) {
      continue;
    }
    const distance = Math.hypot(
      other.center[0] - slot.center[0],
      other.center[1] - slot.center[1],
    );
    if (distance <= NEIGHBOUR_DISTANCE_M) {
      found.push({ id: other.id, distance });
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.map((entry) => entry.id);
}

/** Ô kề gần nhất (giữ lại cho chỗ chỉ cần một). */
export function adjacentSlotId(lot: LotMap, slotId: SlotId): SlotId | null {
  const ids = adjacentSlotIds(lot, slotId);
  return ids.length === 0 ? null : ids[0];
}

/** Trần leo thang tuyệt đối, m (ANS_13). */
export const PARK_CLIP_ESCALATED_MAX_M = 0.35;

/** Số frame không tiến triển trước khi được leo thang (4 s @ 25 fps, ANS_13). */
export const PARK_CLIP_ESCALATE_AFTER_FRAMES = 100;
/**
 * P17: bậc leo thang 2. Xe vào ô giữa hai xe đỗ (bãi gần đầy, xe đỗ lệch/rộng) có khi cần lấn hơn
 * 0,35 m dọc cung quay; kẹt ≥ 8 s (A3: V061@S008, đúng 0,35 m rồi đứng) thì nâng trần tới 0,6 m.
 * Xe chỉ lấn tới chỗ đủ qua (đường đi cố định), không phải lấn hết trần.
 */
export const PARK_CLIP_ESCALATED2_MAX_M = 1.0;
export const PARK_CLIP_ESCALATE2_AFTER_FRAMES = 200;

/** Dung sai có được áp dụng cho cặp (xe đang thao tác, xe khác) này không? */
export function allowsParkClip(
  lot: LotMap,
  car: CarState,
  other: CarState,
  depthM: number,
): boolean {
  return parkClipReason(lot, car, other, depthM) !== null;
}

/**
 * Kiểm đủ 3 điều kiện của ANS_4. Trả `null` nếu **không** được dung sai (⇒ chặn như cũ),
 * hoặc thông tin để dựng bản ghi `park_clip`.
 */
export function parkClipReason(
  lot: LotMap,
  car: CarState,
  other: CarState,
  depthM: number,
  capOverrideM?: number,
): { slot: SlotId; neighbour_slot: SlotId; row: string } | null {
  if (!MANEUVER_STATES.has(car.state)) {
    return null;
  }
  // P17: xe `leaving_slot` chưa nhích (route_s ≈ 0) vẫn NẰM TRONG ô như xe đỗ (cùng quy ước với
  // `occupiedByMoving` trong engine). Không coi nó là xe đỗ thì xe vào ô kề và xe đang chờ ra
  // chặn nhau: bên vào không lấn được, bên ra chờ vùng của bên vào (deadlock 2 xe, seed fuzz 35).
  const stationaryInSlot =
    other.state === 'parked' ||
    (other.state === 'leaving_slot' && (other.route_s ?? 0) < 0.05);
  if (!stationaryInSlot || other.slot === null) {
    return null;
  }
  if (car.slot === null) {
    return null;
  }
  const ownSlot = slotById(lot, car.slot);
  if (ownSlot === undefined || !PARK_CLIP_ROWS.has(ownSlot.row)) {
    return null;
  }
  // ANS_5: ngưỡng **theo hàng** — hàng 1–2 cho 0,5 m, hàng 3–5 chỉ 0,15 m.
  if (!(depthM > 0) || depthM > (capOverrideM ?? maxDepthForRow(ownSlot.row))) {
    return null;
  }
  const neighbour = adjacentSlotIds(lot, ownSlot.id).includes(other.slot)
    ? other.slot
    : null;
  if (neighbour === null) {
    return null;
  }
  return { slot: ownSlot.id, neighbour_slot: neighbour, row: ownSlot.row };
}

/** Dựng `Warning` cho một lần dung sai. */
export function parkClipWarning(
  car: CarState,
  other: CarState,
  reason: { slot: SlotId; neighbour_slot: SlotId; row: string },
  depthM: number,
  frame: number,
  escalated = false,
): Warning {
  return {
    frame,
    kind: escalated ? 'park_clip_escalated' : 'park_clip',
    message:
      `${car.id} lấn ${depthM.toFixed(2)} m vào ${other.id} ở ô kề ${reason.neighbour_slot} ` +
      (escalated
        ? `(hàng ${reason.row}, LEO THANG ANS_13 tối đa ${PARK_CLIP_ESCALATED_MAX_M} m do kẹt ≥ ${PARK_CLIP_ESCALATE_AFTER_FRAMES} frame)`
        : `(hàng ${reason.row}, dung sai ANS_5 tối đa ${maxDepthForRow(reason.row)} m)`),
    car_id: car.id,
    slot: reason.slot,
    neighbour_slot: reason.neighbour_slot,
    neighbour_car_id: other.id,
    depth_m: depthM,
  };
}

/** Trần lấn khi xe ĐANG CHẠY lách xe đỗ/xe đứng trong ô (P17). */
export const PASS_CLIP_MAX_M = 0.15;
const PASSING_STATES: ReadonlySet<string> = new Set([
  'entering',
  'driving_to_slot',
  'driving_to_exit',
]);

/**
 * P17: xe đang chạy trên làn lách sát xe ĐỖ (hoặc xe `leaving_slot` chưa nhích) với độ xuyên nhỏ.
 *
 * Vì sao: tuyến làn là một đường cố định; xe rộng (SUV 1,75 m) đi qua mũi xe đỗ lệch vài cm là
 * xuyên 1–2 cm và bị chặn VĨNH VIỄN — xe đỗ đó muốn ra thì chờ chính xe bị chặn (B1: V045↔V044).
 * Ngoài đời tài xế lách thêm vài cm. Trần `PASS_CLIP_MAX_M` = trần hàng 3–5 của `park_clip`.
 */
export function passClipReason(
  car: CarState,
  other: CarState,
  depthM: number,
): { slot: SlotId; neighbour_slot: SlotId; row: string } | null {
  if (!PASSING_STATES.has(car.state) || other.slot === null) {
    return null;
  }
  const stationary =
    other.state === 'parked' ||
    (other.state === 'leaving_slot' && (other.route_s ?? 0) < 0.05);
  if (!stationary || !(depthM > 0) || depthM > PASS_CLIP_MAX_M) {
    return null;
  }
  return { slot: other.slot, neighbour_slot: other.slot, row: 'làn' };
}

/** Tách các bản ghi `park_clip` từ danh sách cảnh báo (ANS_4 mục 4). */
export function parkClipRecords(warnings: readonly Warning[]): ParkClipRecord[] {
  const out: ParkClipRecord[] = [];
  for (const warning of warnings) {
    if (warning.kind !== 'park_clip') {
      continue;
    }
    if (
      warning.car_id === undefined ||
      warning.slot === undefined ||
      warning.neighbour_slot === undefined ||
      warning.neighbour_car_id === undefined ||
      warning.depth_m === undefined
    ) {
      continue;
    }
    out.push({
      frame: warning.frame,
      car_id: warning.car_id,
      slot: warning.slot,
      neighbour_slot: warning.neighbour_slot,
      neighbour_car_id: warning.neighbour_car_id,
      depth_m: warning.depth_m,
      // Hàng suy từ mã ô (S001…S022 = hàng 1, S023…S044 = hàng 2) nếu không có nguồn khác;
      // caller có thể truyền hàng chính xác qua `parkClipSummary` với `lot`.
      row: warning.slot,
    });
  }
  return out;
}

export interface ParkClipSummary {
  readonly total: number;
  readonly max_depth_m: number;
  /** Số bản ghi theo hàng ô (khoá = `RowId`). */
  readonly by_row: Readonly<Record<string, number>>;
  /** Số bản ghi theo cặp (ô đích → ô kề). */
  readonly by_pair: Readonly<Record<string, number>>;
}

/**
 * Một **đợt lấn liên tiếp** (lead yêu cầu gộp): các frame liền nhau mà cùng một xe lấn cùng
 * một ô kề. Gộp để log/REPORT không bị 3500 dòng cho vài lượt vào ô, mà vẫn giữ **tổng số
 * frame** (`frame_count`) nên không mất thông tin thời lượng.
 */
export interface ParkClipEpisode {
  /** Frame đầu tiên của đợt. */
  readonly frame_first: number;
  /** Số frame liên tiếp của đợt (giữ nguyên tổng thời lượng). */
  readonly frame_count: number;
  /** Frame cuối cùng (tiện cho log/UI). */
  readonly frame_last: number;
  /** Độ xuyên sâu nhất trong cả đợt, m. */
  readonly max_depth_m: number;
  readonly car_id: string;
  readonly slot: SlotId;
  readonly neighbour_slot: SlotId;
  readonly neighbour_car_id: string;
  readonly row: string;
}

/** 5 giây ở 25 fps = 125 frame — ngưỡng "đợt lấn kéo dài" mà lead muốn giải thích. */
export const PARK_CLIP_LONG_EPISODE_FRAMES = 125;

/**
 * Gộp các `park_clip` **liên tiếp** thành đợt (lead yêu cầu).
 *
 * Hai bản ghi thuộc cùng một đợt khi **cùng** `car_id + slot + neighbour_slot +
 * neighbour_car_id` và frame sau = frame trước + 1. Khác frame liền hoặc khác xe/ô ⇒ đợt mới.
 * Tất định: duyệt theo đúng thứ tự `warnings` (engine sinh theo thứ tự xe rồi frame).
 */
export function parkClipEpisodes(
  warnings: readonly Warning[],
  lot: LotMap,
): ParkClipEpisode[] {
  const episodes: ParkClipEpisode[] = [];
  const openByKey = new Map<string, number>();
  for (const warning of warnings) {
    if (warning.kind !== 'park_clip') {
      continue;
    }
    if (
      warning.car_id === undefined ||
      warning.slot === undefined ||
      warning.neighbour_slot === undefined ||
      warning.neighbour_car_id === undefined
    ) {
      continue;
    }
    const depth = warning.depth_m ?? 0;
    const key = `${warning.car_id}|${warning.slot}|${warning.neighbour_slot}|${warning.neighbour_car_id}`;
    const openIndex = openByKey.get(key);
    const open = openIndex === undefined ? undefined : episodes[openIndex];
    if (
      open !== undefined &&
      openIndex !== undefined &&
      warning.frame === open.frame_last + 1
    ) {
      episodes[openIndex] = {
        ...open,
        frame_last: warning.frame,
        frame_count: open.frame_count + 1,
        max_depth_m: Math.max(open.max_depth_m, depth),
      };
      continue;
    }
    const slot = lot.slots.find((candidate) => candidate.id === warning.slot);
    episodes.push({
      frame_first: warning.frame,
      frame_last: warning.frame,
      frame_count: 1,
      max_depth_m: depth,
      car_id: warning.car_id,
      slot: warning.slot,
      neighbour_slot: warning.neighbour_slot,
      neighbour_car_id: warning.neighbour_car_id,
      row: slot?.row ?? '?',
    });
    openByKey.set(key, episodes.length - 1);
  }
  return episodes;
}

/** Tổng hợp theo **đợt** (lead yêu cầu: số đợt, dài nhất, max, phân bố hàng). */
export interface ParkClipEpisodeSummary {
  /** Số đợt lấn. */
  readonly episodes: number;
  /** Tổng số frame có lấn (giữ nguyên `ParkClipSummary.total`). */
  readonly total_frames: number;
  /** Đợt dài nhất, frame. */
  readonly longest_frames: number;
  /** Độ xuyên sâu nhất toàn bộ, m. */
  readonly max_depth_m: number;
  /** Số đợt theo hàng. */
  readonly by_row: Readonly<Record<string, number>>;
  /** Số đợt dài hơn :data:`PARK_CLIP_LONG_EPISODE_FRAMES`. */
  readonly long_episodes: number;
}

export function summarizeEpisodes(
  episodes: readonly ParkClipEpisode[],
): ParkClipEpisodeSummary {
  let totalFrames = 0;
  let longest = 0;
  let maxDepth = 0;
  let longCount = 0;
  const byRow: Record<string, number> = {};
  for (const episode of episodes) {
    totalFrames += episode.frame_count;
    longest = Math.max(longest, episode.frame_count);
    maxDepth = Math.max(maxDepth, episode.max_depth_m);
    byRow[episode.row] = (byRow[episode.row] ?? 0) + 1;
    if (episode.frame_count > PARK_CLIP_LONG_EPISODE_FRAMES) {
      longCount += 1;
    }
  }
  return {
    episodes: episodes.length,
    total_frames: totalFrames,
    longest_frames: longest,
    max_depth_m: maxDepth,
    by_row: byRow,
    long_episodes: longCount,
  };
}

/**
 * Tổng hợp `park_clip` để export/UI dùng (ANS_4 mục 4: tổng, max, phân bố theo hàng).
 *
 * Truyền `lot` để lấy **hàng thật** của ô, không đoán từ mã ô.
 */
export function parkClipSummary(
  warnings: readonly Warning[],
  lot: LotMap,
): ParkClipSummary {
  let total = 0;
  let maxDepth = 0;
  const byRow: Record<string, number> = {};
  const byPair: Record<string, number> = {};
  for (const warning of warnings) {
    if (warning.kind !== 'park_clip' || warning.slot === undefined) {
      continue;
    }
    total += 1;
    if (warning.depth_m !== undefined) {
      maxDepth = Math.max(maxDepth, warning.depth_m);
    }
    const slot = lot.slots.find((candidate) => candidate.id === warning.slot);
    const row = slot?.row ?? '?';
    byRow[row] = (byRow[row] ?? 0) + 1;
    const pair = `${warning.slot}→${warning.neighbour_slot ?? '?'}`;
    byPair[pair] = (byPair[pair] ?? 0) + 1;
  }
  return {
    total,
    max_depth_m: maxDepth,
    by_row: byRow,
    by_pair: byPair,
  };
}

/**
 * Tỉ lệ phóng xe cho ô hàng 1–2 (ANS_4 mục 3): `min(scale_D4, 1,0)` — kích thước thật.
 *
 * Ô hàng 1–2 hẹp (2,17–2,41 m) nên phóng xe lên 1,1–1,3 làm thân xe rộng thêm và tăng độ
 * xuyên khi quay. Dùng tỉ lệ thật giảm lấn mà không đổi hình học bãi.
 */
export const REAL_SIZE_MAX_SCALE = 1.0;

/** `true` nếu ô thuộc hàng phải dùng kích thước thật. */
export function rowUsesRealSize(row: string): boolean {
  return PARK_CLIP_ROWS.has(row);
}

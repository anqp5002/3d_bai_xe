// P17n: BẢN THAM CHIẾU (bản cũ quét toàn history) — chỉ để test so khớp từng byte với bản luồng. Đừng dùng trong code chạy.
/**
 * Ground truth theo frame + theo sự kiện (FE §4.6, C9, D10, U17).
 *
 * Tên file `gtCompute.ts` để không lẫn với contract `contracts/gt.ts` (file contract
 * không được sửa ở P5 — R1). Tên cột giữ đúng bộ cũ (`docs/pklot_video/ds/gen_dataset.py:497-533`):
 * `frame, S001…S100, <car>_u, <car>_v, <car>_cams` và
 * `car, slot, gate_in_frame, parked_frame, depart_frame, cam2_to_cam1_overlap_enter,
 * gate_out_frame, arrival_crosses_cameras` + phần mở rộng `initial_parked, model, color, speed_kmh`.
 *
 * D10 thắng chỗ cũ: `gate_in_frame`/`gate_out_frame` tính bằng **giao đoạn đường đi với
 * đoạn cổng trong world**, không theo cột ảnh; `parked_frame` tính theo C9 (tâm xe nằm
 * trong đa giác ô). GT là trạng thái thật của mô phỏng — không phụ thuộc render/nhiễu.
 */

import type { CameraModel, LotMap, SlotId, Vec2, Vec2Px } from '../contracts/lot';
import { SLOT_IDS } from '../contracts/lot';
import type { CameraMode } from '../contracts/scenario';
import type {
  CamTag,
  GateNote,
  GtCarProjection,
  GtEventRow,
  GtFrameRow,
  SlotOccupancy,
} from '../contracts/gt';
import {
  FRAME_TIMESTAMP_COLUMNS,
  GT_EVENT_COLUMNS,
  GT_FRAME_PREFIX_COLUMNS,
  frameTimestampRow,
} from '../contracts/gt';
import type { CarState, SimState } from '../contracts/sim';
import { pointInPolygon, segmentsIntersect } from './collision';

const DEG_TO_RAD = Math.PI / 180;
/** Độ sâu tối thiểu trước mặt phẳng camera, m. */
const MIN_DEPTH_M = 1e-9;

/**
 * Chiếu một điểm trên mặt đất (m) ra ảnh 640×640 theo đúng công thức `project()` của
 * pipeline cũ (`docs/pklot_video/blender/build_blender_video.py:56-59`).
 */
export function projectPoint(camera: CameraModel, x: number, y: number): Vec2Px {
  const pitch = camera.pitch_deg * DEG_TO_RAD;
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const depth = y * cos + camera.height_m * sin;
  if (!Number.isFinite(depth) || depth <= MIN_DEPTH_M) {
    throw new Error(
      `projectPoint: điểm (${String(x)}, ${String(y)}) nằm sau mặt phẳng camera`,
    );
  }
  const u = camera.res[0] / 2 + (camera.f_px * x) / depth;
  const v =
    camera.res[1] / 2 +
    (camera.f_px * (-y * sin + camera.height_m * cos)) / depth;
  return [u, v];
}

/** Nhãn camera của một điểm ảnh (FE §4.6). Rỗng = ngoài khung. */
export function camsForPoint(
  camera: CameraModel,
  u: number,
  v: number,
  mode: CameraMode,
): CamTag {
  if (!(v >= 0 && v < camera.res[1])) {
    return '';
  }
  if (mode === '1cam') {
    return u >= 0 && u < camera.res[0] ? 'cam1' : '';
  }
  const inCam1 = u >= camera.cam1_x[0] && u < camera.cam1_x[1];
  const inCam2 = u >= camera.cam2_x[0] && u < camera.cam2_x[1];
  if (inCam1 && inCam2) {
    return 'cam1+cam2';
  }
  if (inCam1) {
    return 'cam1';
  }
  if (inCam2) {
    return 'cam2';
  }
  return '';
}

/** Làm tròn 1 chữ số thập phân như CSV bộ cũ (không trả về -0). */
export function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function slotPolygon(lot: LotMap, slot: SlotId): readonly Vec2[] {
  const found = lot.slots.find((candidate) => candidate.id === slot);
  if (found === undefined) {
    throw new Error(`gtCompute: ô "${slot}" không có trong bãi "${lot.name}"`);
  }
  return found.polygon;
}

/**
 * Một dòng `gt_frames.csv` của state hiện tại (C9: tâm xe trong đa giác ô).
 * Xe `exited` coi như không có mặt — không có khoá trong `cars`.
 */
export function gtRow(
  lot: LotMap,
  state: SimState,
  mode: CameraMode,
): GtFrameRow {
  const occupancy: Record<SlotId, SlotOccupancy> = {} as Record<SlotId, SlotOccupancy>;
  for (const slotId of SLOT_IDS) {
    occupancy[slotId] = 0;
  }
  const present = state.cars.filter((car) => car.state !== 'exited');
  for (const car of present) {
    const center: Vec2 = [car.pose.x, car.pose.y];
    for (const slot of lot.slots) {
      if (pointInPolygon(center, slot.polygon)) {
        occupancy[slot.id] = 1;
      }
    }
  }
  const cars: Record<string, GtCarProjection> = {};
  for (const car of present) {
    const [u, v] = projectPoint(lot.camera, car.pose.x, car.pose.y);
    cars[car.id] = {
      u: round1(u),
      v: round1(v),
      cams: camsForPoint(lot.camera, u, v, mode),
    };
  }
  return { frame: state.frame, occupancy, cars };
}

/** Mã xe theo thứ tự xuất hiện lần đầu — thứ tự cột trong `gt_frames.csv`. */
export function collectCarIds(history: readonly SimState[]): readonly string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const state of history) {
    for (const car of state.cars) {
      if (!seen.has(car.id)) {
        seen.add(car.id);
        order.push(car.id);
      }
    }
  }
  return order;
}

interface TimelineEntry {
  readonly frame: number;
  readonly car: CarState;
}

interface Timeline {
  readonly id: string;
  readonly entries: readonly TimelineEntry[];
}

function buildTimelines(history: readonly SimState[]): readonly Timeline[] {
  const order: string[] = [];
  const byId = new Map<string, TimelineEntry[]>();
  for (const state of history) {
    for (const car of state.cars) {
      let entries = byId.get(car.id);
      if (entries === undefined) {
        entries = [];
        byId.set(car.id, entries);
        order.push(car.id);
      }
      entries.push({ frame: state.frame, car });
    }
  }
  return order.map((id) => ({ id, entries: byId.get(id) ?? [] }));
}

function centerOf(car: CarState): Vec2 {
  return [car.pose.x, car.pose.y];
}

/** Frame đầu tiên đường đi cắt đoạn cổng, chỉ xét frame > `afterFrame`. */
function firstGateCrossing(
  entries: readonly TimelineEntry[],
  gateA: Vec2,
  gateB: Vec2,
  afterFrame: number,
): number | null {
  for (let index = 1; index < entries.length; index += 1) {
    const current = entries[index];
    if (current.frame <= afterFrame) {
      continue;
    }
    const previous = entries[index - 1];
    if (
      segmentsIntersect(
        centerOf(previous.car),
        centerOf(current.car),
        gateA,
        gateB,
      )
    ) {
      return current.frame;
    }
  }
  return null;
}

/** Frame đầu tiên tâm xe vào đa giác ô đích (C9), tính từ `fromFrame`. */
function firstInsideSlot(
  entries: readonly TimelineEntry[],
  polygon: readonly Vec2[],
  fromFrame: number,
): number | null {
  for (const entry of entries) {
    if (entry.frame < fromFrame) {
      continue;
    }
    if (entry.car.state === 'parked' && pointInPolygon(centerOf(entry.car), polygon)) {
      return entry.frame;
    }
  }
  return null;
}

/**
 * Một dòng `gt_events.csv` cho mỗi chu trình xe, theo thứ tự xuất hiện (FE §4.6, D10).
 *
 * `speed_kmh` lấy **tốc độ người dùng đặt** (`CarState.desired_speed_mps`), không
 * lấy tốc độ lớn nhất quan sát được; chỉ khi dữ liệu cũ không có trường này mới
 * quay về tốc độ lớn nhất (REPORT_P5a #2).
 */
export function gtEvents(
  lot: LotMap,
  history: readonly SimState[],
  /**
   * Ô không đếm được cổng → lý do (P11c mục 2, ANS_17).
   *
   * Xe vào ô có mặt trong map này sẽ có `gate_in_frame`/`gate_out_frame` = **null**
   * (rỗng theo thiết kế) và `gate_note` = lý do, để `verify.py` mục 3 bỏ qua thứ tự cổng.
   * Bỏ trống = không ô nào bị cờ.
   */
  gateNotes: ReadonlyMap<string, GateNote> = new Map(),
): readonly GtEventRow[] {
  if (history.length === 0) {
    return [];
  }
  const start = history[0];
  const initialIds = new Set(
    start.cars.filter((car) => car.state === 'parked').map((car) => car.id),
  );
  return buildTimelines(history).map((timeline) => {
    const entries = timeline.entries;
    const first = entries[0];
    const initialParked = initialIds.has(timeline.id);
    const slot = entries.find((entry) => entry.car.slot !== null)?.car.slot ?? null;

    const gateInFrame = initialParked
      ? null
      : firstGateCrossing(entries, lot.gates.in.p1, lot.gates.in.p2, -1);

    let parkedFrame: number | null = null;
    if (!initialParked && slot !== null) {
      parkedFrame = firstInsideSlot(entries, slotPolygon(lot, slot), 0);
    }

    let departFrame: number | null = null;
    if (initialParked || parkedFrame !== null) {
      const searchFrom = parkedFrame ?? -1;
      for (const entry of entries) {
        if (entry.frame > searchFrom && entry.car.state !== 'parked') {
          departFrame = entry.frame;
          break;
        }
      }
    }

    let overlapEnterFrame: number | null = null;
    if (departFrame !== null) {
      for (const entry of entries) {
        if (entry.frame <= departFrame) {
          continue;
        }
        const [u] = projectPoint(lot.camera, entry.car.pose.x, entry.car.pose.y);
        if (u < lot.camera.cam1_x[1]) {
          overlapEnterFrame = entry.frame;
          break;
        }
      }
    }

    const gateOutFrame = firstGateCrossing(
      entries,
      lot.gates.out.p1,
      lot.gates.out.p2,
      departFrame ?? -1,
    );

    let arrivalCrosses = 0;
    if (parkedFrame !== null) {
      for (const entry of entries) {
        if (entry.frame > parkedFrame) {
          break;
        }
        const [u] = projectPoint(lot.camera, entry.car.pose.x, entry.car.pose.y);
        if (u < lot.camera.cam2_x[0]) {
          arrivalCrosses = 1;
          break;
        }
      }
    }

    let maxSpeed = 0;
    for (const entry of entries) {
      maxSpeed = Math.max(maxSpeed, Math.abs(entry.car.v));
    }
    const desiredSpeed = entries.reduce<number | null>((found, entry) => {
      const value = entry.car.desired_speed_mps;
      return value === undefined ? found : value;
    }, null);

    // P11c mục 2: ô không đếm được cổng ⇒ GT để **rỗng** hai cột cổng và ghi lý do.
    // Không "sửa" số: đây là khai báo rằng vị trí vạch/camera không cho phép đo, không phải xe
    // không có cổng.
    const gateNote = slot === null ? null : (gateNotes.get(slot) ?? null);
    const blankGate = gateNote !== null;

    return {
      car: timeline.id,
      slot,
      gate_in_frame: blankGate ? null : gateInFrame,
      parked_frame: parkedFrame,
      depart_frame: departFrame,
      cam2_to_cam1_overlap_enter: overlapEnterFrame,
      gate_out_frame: blankGate ? null : gateOutFrame,
      arrival_crosses_cameras: arrivalCrosses === 1 ? 1 : 0,
      initial_parked: initialParked ? 1 : 0,
      model: first.car.model,
      color: first.car.color,
      speed_kmh: round1((desiredSpeed ?? maxSpeed) * 3.6),
      gate_note: gateNote,
    };
  });
}

function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function eventCell(value: number | string | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`gtEventsCsv: số không hữu hạn ${String(value)}`);
    }
    return String(value);
  }
  return escapeCsv(value);
}

/**
 * Nội dung `gt_frames.csv` (UTF-8, LF). `carIds` quyết định thứ tự cột xe.
 * Xe không có mặt trong frame → 3 ô trống, đúng như bộ cũ.
 */
export function gtFramesCsv(
  rows: readonly GtFrameRow[],
  carIds: readonly string[],
): string {
  const header = [
    ...GT_FRAME_PREFIX_COLUMNS,
    ...SLOT_IDS,
    ...carIds.flatMap((carId) => [`${carId}_u`, `${carId}_v`, `${carId}_cams`]),
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells: string[] = [String(row.frame)];
    for (const slotId of SLOT_IDS) {
      cells.push(String(row.occupancy[slotId]));
    }
    for (const carId of carIds) {
      const projection = row.cars[carId];
      if (projection === undefined) {
        cells.push('', '', '');
        continue;
      }
      cells.push(
        projection.u === null ? '' : projection.u.toFixed(1),
        projection.v === null ? '' : projection.v.toFixed(1),
        projection.cams,
      );
    }
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Nội dung `gt_events.csv` (UTF-8, LF), đúng thứ tự `GT_EVENT_COLUMNS`. */
export function gtEventsCsv(rows: readonly GtEventRow[]): string {
  const lines = [GT_EVENT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(GT_EVENT_COLUMNS.map((column) => eventCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Nội dung `frame_timestamps.csv`: `frame_idx` bắt đầu 1,
 * `ns = 1e12 + f × 40 000 000` (khớp `gen_dataset.py:474-475`).
 */
export function frameTimestampsCsv(frameCount: number): string {
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new Error(
      `frameTimestampsCsv: frameCount phải là số nguyên ≥ 0, nhận ${String(frameCount)}`,
    );
  }
  const lines = [FRAME_TIMESTAMP_COLUMNS.join(',')];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const row = frameTimestampRow(frame);
    lines.push(`${row.frame_idx},${row.cam1_monotonic_ns},${row.cam2_monotonic_ns}`);
  }
  return `${lines.join('\n')}\n`;
}

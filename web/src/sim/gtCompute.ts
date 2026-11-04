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

function centerOf(car: CarState): Vec2 {
  return [car.pose.x, car.pose.y];
}

/**
 * Trạng thái tăng dần của MỘT xe để tính một dòng `gt_events.csv` (P17n: tính GT theo luồng).
 *
 * Bản cũ gom toàn bộ `entries` của xe rồi quét nhiều lượt; bản này cập nhật từng frame với bộ nhớ
 * O(1) mỗi xe. Mỗi trường được tính **đúng định nghĩa cũ** (xem chú thích từng trường) — test
 * `gtStream.test.ts` so khớp từng byte với bản quét toàn history.
 */
interface EventAcc {
  readonly id: string;
  readonly model: CarState['model'];
  readonly color: CarState['color'];
  readonly initialParked: boolean;
  slot: SlotId | null;
  /** Điểm tâm của entry trước (để xét cắt vạch giữa hai entry liên tiếp của xe). */
  prev: Vec2 | null;
  gateInFrame: number | null;
  /** Mọi frame cắt vạch ra; `gateOutFrame` = frame đầu tiên `> departFrame ?? -1` (chọn lúc kết). */
  gateOutCrossings: number[];
  parkedFrame: number | null;
  departFrame: number | null;
  overlapEnterFrame: number | null;
  /** Có entry nào (frame ≤ parked) mà `u < cam2_x[0]` — chỉ cập nhật khi chưa tìm thấy parked. */
  earlyBeyondCam2: boolean;
  maxSpeed: number;
  desiredSpeed: number | null;
}

/**
 * `gt_events.csv` tính theo luồng: gọi {@link GtEventsStream.push} đúng một lần cho mỗi frame, liên
 * tiếp từ frame 0, rồi {@link GtEventsStream.finish}. `gtEvents(lot, history)` chỉ là bọc quanh lớp
 * này (một cài đặt duy nhất).
 */
export class GtEventsStream {
  private readonly cars = new Map<string, EventAcc>();
  private readonly order: string[] = [];
  private initialIds: ReadonlySet<string> | null = null;
  private readonly polygons = new Map<SlotId, readonly Vec2[]>();

  constructor(private readonly lot: LotMap) {}

  push(state: SimState): void {
    const lot = this.lot;
    if (this.initialIds === null) {
      this.initialIds = new Set(
        state.cars.filter((car) => car.state === 'parked').map((car) => car.id),
      );
    }
    for (const car of state.cars) {
      let acc = this.cars.get(car.id);
      if (acc === undefined) {
        acc = {
          id: car.id,
          model: car.model,
          color: car.color,
          initialParked: this.initialIds.has(car.id),
          slot: null,
          prev: null,
          gateInFrame: null,
          gateOutCrossings: [],
          parkedFrame: null,
          departFrame: null,
          overlapEnterFrame: null,
          earlyBeyondCam2: false,
          maxSpeed: 0,
          desiredSpeed: null,
        };
        this.cars.set(car.id, acc);
        this.order.push(car.id);
      }
      const frame = state.frame;
      const center = centerOf(car);
      if (acc.slot === null && car.slot !== null) {
        acc.slot = car.slot;
      }
      // Cắt vạch (giữa entry trước và entry này).
      if (acc.prev !== null) {
        if (
          acc.gateInFrame === null &&
          !acc.initialParked &&
          segmentsIntersect(acc.prev, center, lot.gates.in.p1, lot.gates.in.p2)
        ) {
          acc.gateInFrame = frame;
        }
        if (segmentsIntersect(acc.prev, center, lot.gates.out.p1, lot.gates.out.p2)) {
          acc.gateOutCrossings.push(frame);
        }
      }
      acc.prev = center;

      const needU =
        (acc.parkedFrame === null && !acc.initialParked) ||
        (acc.departFrame !== null && acc.overlapEnterFrame === null);
      const u = needU ? projectPoint(lot.camera, car.pose.x, car.pose.y)[0] : 0;

      // overlap: entry có frame > departFrame (departFrame đã biết từ frame TRƯỚC).
      if (
        acc.departFrame !== null &&
        acc.overlapEnterFrame === null &&
        frame > acc.departFrame &&
        u < lot.camera.cam1_x[1]
      ) {
        acc.overlapEnterFrame = frame;
      }
      // depart: entry đầu tiên có frame > searchFrom và state ≠ parked
      // (initialParked: searchFrom = −1; còn lại: frame của parked_frame, đã biết từ frame trước).
      if (acc.departFrame === null) {
        if (acc.initialParked) {
          if (car.state !== 'parked') {
            acc.departFrame = frame;
          }
        } else if (acc.parkedFrame !== null && frame > acc.parkedFrame && car.state !== 'parked') {
          acc.departFrame = frame;
        }
      }
      // arrival_crosses_cameras: entry có frame ≤ parked_frame với u < cam2_x[0].
      if (!acc.initialParked && acc.parkedFrame === null && u < lot.camera.cam2_x[0]) {
        acc.earlyBeyondCam2 = true;
      }
      // parked_frame: entry đầu tiên (parked + tâm trong đa giác ô `slot` — ô đầu tiên khác null).
      if (!acc.initialParked && acc.parkedFrame === null && acc.slot !== null && car.state === 'parked') {
        let polygon = this.polygons.get(acc.slot);
        if (polygon === undefined) {
          polygon = slotPolygon(lot, acc.slot);
          this.polygons.set(acc.slot, polygon);
        }
        if (pointInPolygon(center, polygon)) {
          acc.parkedFrame = frame;
        }
      }
      acc.maxSpeed = Math.max(acc.maxSpeed, Math.abs(car.v));
      if (car.desired_speed_mps !== undefined) {
        acc.desiredSpeed = car.desired_speed_mps;
      }
    }
  }

  finish(gateNotes: ReadonlyMap<string, GateNote> = new Map()): readonly GtEventRow[] {
    return this.order.map((id) => {
      const acc = this.cars.get(id) as EventAcc;
      const departFrame = acc.departFrame;
      const afterFrame = departFrame ?? -1;
      const gateOutFrame = acc.gateOutCrossings.find((frame) => frame > afterFrame) ?? null;
      const arrivalCrosses = acc.parkedFrame !== null && acc.earlyBeyondCam2 ? 1 : 0;
      const gateNote = acc.slot === null ? null : (gateNotes.get(acc.slot) ?? null);
      const blankGate = gateNote !== null;
      return {
        car: acc.id,
        slot: acc.slot,
        gate_in_frame: blankGate ? null : acc.gateInFrame,
        parked_frame: acc.parkedFrame,
        depart_frame: departFrame,
        cam2_to_cam1_overlap_enter: acc.overlapEnterFrame,
        gate_out_frame: blankGate ? null : gateOutFrame,
        arrival_crosses_cameras: arrivalCrosses === 1 ? 1 : 0,
        initial_parked: acc.initialParked ? 1 : 0,
        model: acc.model,
        color: acc.color,
        speed_kmh: round1((acc.desiredSpeed ?? acc.maxSpeed) * 3.6),
        gate_note: gateNote,
      };
    });
  }
}

/**
 * Một dòng `gt_events.csv` cho mỗi chu trình xe, theo thứ tự xuất hiện (FE §4.6, D10).
 *
 * `speed_kmh` lấy **tốc độ người dùng đặt** (`CarState.desired_speed_mps`), không
 * lấy tốc độ lớn nhất quan sát được; chỉ khi dữ liệu cũ không có trường này mới
 * quay về tốc độ lớn nhất (REPORT_P5a #2).
 *
 * P17n: cài đặt duy nhất là {@link GtEventsStream}; hàm này chỉ đẩy cả `history` qua nó.
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
  const stream = new GtEventsStream(lot);
  for (const state of history) {
    stream.push(state);
  }
  return stream.finish(gateNotes);
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

/**
 * `gt_frames.csv` tính theo luồng (P17n): mỗi frame chỉ giữ MỘT chuỗi thưa (ô + các xe đang có mặt),
 * không giữ `GtFrameRow` đầy đủ lẫn `SimState`. Thứ tự cột xe = thứ tự xuất hiện lần đầu trong
 * `state.cars` (giống {@link collectCarIds}); header chỉ biết ở cuối nên {@link GtFramesStream.finish}
 * mới ghép CSV. Kết quả giống từng byte `gtFramesCsv(history.map(gtRow), collectCarIds(history))`.
 */
export class GtFramesStream {
  private readonly index = new Map<string, number>();
  private readonly ids: string[] = [];
  private readonly rows: string[] = [];

  constructor(
    private readonly lot: LotMap,
    private readonly mode: CameraMode,
  ) {}

  /** Mã xe theo thứ tự xuất hiện lần đầu (thứ tự cột xe). */
  get carIds(): readonly string[] {
    return this.ids;
  }

  push(state: SimState): void {
    for (const car of state.cars) {
      if (!this.index.has(car.id)) {
        this.index.set(car.id, this.ids.length);
        this.ids.push(car.id);
      }
    }
    const row = gtRow(this.lot, state, this.mode);
    const prefix = [String(row.frame)];
    for (const slotId of SLOT_IDS) {
      prefix.push(String(row.occupancy[slotId]));
    }
    const entries: string[] = [];
    for (const carId of Object.keys(row.cars)) {
      const projection = row.cars[carId];
      entries.push(
        `${String(this.index.get(carId))}/${projection.u === null ? '' : projection.u.toFixed(1)}/${
          projection.v === null ? '' : projection.v.toFixed(1)
        }/${projection.cams}`,
      );
    }
    this.rows.push(`${prefix.join(',')}|${entries.join(';')}`);
  }

  /** Số frame đã nhận. */
  get frameCount(): number {
    return this.rows.length;
  }

  finish(): string {
    const header = [
      ...GT_FRAME_PREFIX_COLUMNS,
      ...SLOT_IDS,
      ...this.ids.flatMap((carId) => [`${carId}_u`, `${carId}_v`, `${carId}_cams`]),
    ];
    const lines = [header.join(',')];
    const width = this.ids.length;
    for (const packed of this.rows) {
      const cut = packed.indexOf('|');
      const cells: string[] = new Array<string>(width * 3).fill('');
      const tail = packed.slice(cut + 1);
      if (tail !== '') {
        for (const entry of tail.split(';')) {
          const [indexText, u, v, cams] = entry.split('/');
          const base = Number(indexText) * 3;
          cells[base] = u;
          cells[base + 1] = v;
          cells[base + 2] = cams;
        }
      }
      lines.push(width === 0 ? packed.slice(0, cut) : `${packed.slice(0, cut)},${cells.join(',')}`);
    }
    return `${lines.join('\n')}\n`;
  }
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

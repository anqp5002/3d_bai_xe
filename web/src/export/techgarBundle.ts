/**
 * Lắp bộ `techgar_config/` từ `lot` (BE §5, G0/`ANS_1` A.1–A.4).
 *
 * Sinh 8 file: `calibration.json`, `parking_slots_cam1.json`, `parking_slots_cam2.json`,
 * `gate_zones.json`, `roi_mask_cam1.json`, `roi_mask_cam2.json`, `MANIFEST.json`,
 * `README.txt`. Hàm thuần: chỉ đọc `lot` + tham số, không fetch/DOM/file.
 *
 * Chế độ **1 cam không xuất `techgar_config/`** (ANS_1 A.1: TechGAR bắt buộc 2 cam) —
 * `buildTechgarConfig` trả `null` khi `cameraMode === '1cam'`.
 */

import type { LotMap, Vec2 } from '../contracts/lot';
import type { CameraMode } from '../contracts/scenario';
import {
  CAM_MEMBERSHIP_RATIO,
  DEPTH_CHECK_TOLERANCE,
  SAMPLE_MATCHING_DEFAULTS,
  SAMPLE_SLOT_LONG_MEDIAN,
  SAMPLE_SLOT_SHORT_MEDIAN,
  SAMPLE_TRACKING_DEFAULTS,
  TECHGAR_IMAGE,
  TECHGAR_SCALE,
  techgarImageSize,
  TechgarConfigError,
  boundsOf,
  checkDepthConsistency,
  computeK,
  groundPoint,
  imageToWorldHomography,
  lotCenter,
  medianSlotDepthM,
  medianSlotWidthM,
  round4,
  toTechgarPoint,
  WORLD_UNIT,
  type ConfigFile,
  type TechgarConfigBundle,
} from './techgarConfig';
import { projectPoint } from '../sim/gtCompute';
import { belongsToCamera, slotsForCamera, visibleRatioInCamera } from './slotsByCamera';
import { buildCountLines, COUNT_LINE_MARGIN_M, type CountLines } from './countLines';

/** Vùng cắt ảnh của cam1/cam2 (U19). Trùng `lot.camera.cam1_x`/`cam2_x`, nhưng ghi rõ ở đây. */
export const CAMERA_CROPS = {
  cam1: [0, 400],
  cam2: [240, 640],
} as const;

/** Số cảnh báo tối đa hiện trong README (tránh file phình). */
const MAX_WARNINGS = 8;

/** Đối tượng point của gate (`{x, y}` theo schema `gate_zones.json`). */
interface GatePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * `direction` của cổng. `REPORT_P0` (e): `positive` = xe đi sang **phải** đường `p1→p2`
 * (cross product > 0). Xe vào bãi chạy về tây, xe ra cũng chạy về tây (C6), nên chỉ cần
 * đảo thứ tự `p1/p2` giữa hai cổng để `cross` đúng dấu.
 */
function gateDirection(p1: Vec2, p2: Vec2, travel: Vec2): 'positive' | 'negative' {
  const gx = p2[0] - p1[0];
  const gy = p2[1] - p1[1];
  // Vector "đi qua cổng" là hướng xe chạy; chiếu lên pháp tuyến của đoạn cổng.
  const cross = travel[0] * gy - travel[1] * gx;
  if (Math.abs(cross) < 1e-12) {
    throw new TechgarConfigError(
      'gateDirection: hướng xe song song với đoạn cổng — không xác định được chiều qua cổng',
    );
  }
  return cross > 0 ? 'positive' : 'negative';
}

/** Hướng xe đi qua một cổng, lấy từ `despawn - spawn` của `lot.gates` (C6: về tây). */
function gateTravel(gate: { spawn: readonly [number, number, number]; despawn: Vec2 }): Vec2 {
  return [gate.despawn[0] - gate.spawn[0], gate.despawn[1] - gate.spawn[1]];
}

/** File `gate_zones.json` (đúng schema `config/gate_zones.json` của TechGAR). */
export interface GateZonesFile {
  readonly schema_version: 1;
  readonly coordinate_space: 'world';
  readonly unit: string;
  readonly source: 'sim3d';
  readonly entry_gate: {
    readonly name: string;
    readonly p1: GatePoint;
    readonly p2: GatePoint;
    readonly direction: 'positive' | 'negative';
  };
  readonly exit_gate: {
    readonly name: string;
    readonly p1: GatePoint;
    readonly p2: GatePoint;
    readonly direction: 'positive' | 'negative';
  };
}

/**
 * Sinh `gate_zones.json` từ **vạch đếm** (`countLines`, ANS_14/P11), đổi sang world unit.
 *
 * Vạch đếm khác vạch cổng vẽ: cổng vẽ sát mép khung nên tracker chưa kịp có Global ID khi xe
 * đi qua (đo: 9/9 mẫu vào, 10/10 mẫu ra đều cấp/mất ID **sau** khi đã qua cổng). Vạch đếm
 * nằm sâu hơn, chỗ tracker đã có ID ⇒ `gate_session_controller` đếm được.
 *
 * `direction` tính **trên vạch đếm** bằng cùng công thức với vạch cổng ⇒ giữ đúng chiều.
 */
export function buildGateZones(
  lot: LotMap,
  origin: Vec2,
  k: number,
  lines: CountLines = buildCountLines(lot),
): GateZonesFile {
  const entry = lines.entry;
  const exit = lines.exit;
  const entryP1 = toTechgarPoint(entry.p1, origin, k);
  const entryP2 = toTechgarPoint(entry.p2, origin, k);
  const exitP1 = toTechgarPoint(exit.p1, origin, k);
  const exitP2 = toTechgarPoint(exit.p2, origin, k);
  return {
    schema_version: 1,
    coordinate_space: 'world',
    unit: WORLD_UNIT,
    source: 'sim3d',
    entry_gate: {
      name: 'Cổng vào (vạch đếm)',
      p1: { x: round4(entryP1[0]), y: round4(entryP1[1]) },
      p2: { x: round4(entryP2[0]), y: round4(entryP2[1]) },
      direction: gateDirection(entry.p1, entry.p2, gateTravel(lot.gates.in)),
    },
    exit_gate: {
      name: 'Cổng ra (vạch đếm)',
      p1: { x: round4(exitP1[0]), y: round4(exitP1[1]) },
      p2: { x: round4(exitP2[0]), y: round4(exitP2[1]) },
      direction: gateDirection(exit.p1, exit.p2, gateTravel(lot.gates.out)),
    },
  };
}

/** File `roi_mask_cam{1,2}.json` (schema `config/roi_mask_cam1.json` + kích thước 400×640). */
export interface RoiMaskFile {
  readonly polygon: readonly GatePoint[];
  readonly image_size: readonly [number, number];
}

/**
 * Sinh mask vùng bãi hợp lệ cho một cam: **bao toàn mặt bãi xe chạy được**
 * (BRIEF_P15 mục B), nhân hệ số `scale`.
 *
 * **Vì sao đổi:** bản cũ lấy **khung bao các ô đỗ** của cam. Mask đó cắt mất làn
 * chạy phía trên và dưới (cam1 `y 147–506`, cam2 `y 143–506` trên 640), gồm cả làn A2
 * có vạch đếm. TechGAR chỉ xét vật chuyển động có đủ `roi_support_pixels` trong mask
 * (`motion_tracker.py:876-880`: `max(20, min(160, 0.08 * diện_tích_contour))`) nên xe bị cắt
 * một phần là mất. Đo được: mask cũ **24 %/5 %**, mask mới **83 %/70 %** xe-frame đang chạy.
 *
 * **Cách lấy:** hợp khung bao của **mọi ô trong khung cam** với khung bao **các làn cắt khung**
 * (`lot.aisles`), rồi kẹp vào khung ảnh. Nhờ vậy mask phủ cả đường chạy và đoạn cổng;
 * lần A1/A2/A3 và vạch đếm đều nằm trong.
 */
/**
 * Chiếu một polyline **world (mét)** sang pixel khung cắt rồi gom các đỉnh cần mask phủ.
 *
 * Mỗi đoạn được **cắt** tại hai biên `crop[0]`/`crop[1]`: phần nằm trong khung là đường xe chạy
 * nên phải phủ, kể cả khi một đầu đoạn nằm ngoài khung (làn cổng vào world x=44,98 → u=705,
 * vượt mép 640 của cam2). Điểm cắt dùng `v` nội suy theo tỉ lệ `u` để mask không cao/ thấp sai.
 */
function addWorldPoints(
  us: number[],
  vs: number[],
  camera: LotMap['camera'],
  crop: readonly [number, number],
  cropU0: number,
  polyline: readonly Vec2[],
): void {
  const projected = polyline.map(([x, y]) => projectPoint(camera, x, y));
  for (let index = 0; index < projected.length; index += 1) {
    const [u, v] = projected[index];
    if (u >= crop[0] && u <= crop[1]) {
      us.push(u - cropU0);
      vs.push(v);
    }
    const next = projected[index + 1];
    if (next === undefined) {
      continue;
    }
    const [nextU, nextV] = next;
    if (nextU === u) {
      continue;
    }
    // Cắt đoạn tại từng biên khung mà đoạn thật sự vượt qua.
    for (const edge of crop) {
      const crosses = (u - edge) * (nextU - edge) < 0;
      if (!crosses) {
        continue;
      }
      const t = (edge - u) / (nextU - u);
      us.push(edge - cropU0);
      vs.push(v + t * (nextV - v));
    }
  }
}

export function buildRoiMask(
  lot: LotMap,
  crop: readonly [number, number],
  cropU0: number,
  scale = 1,
): RoiMaskFile {
  const members = lot.slots.filter((slot) => belongsToCamera(slot, crop));
  if (members.length === 0) {
    throw new TechgarConfigError(
      `buildRoiMask: không ô nào thuộc khung cam [${String(crop[0])}, ${String(crop[1])}]`,
    );
  }

  // Điểm ảnh (toạ độ gốc 400×640 của khung cắt) cần phủ.
  const us: number[] = [];
  const vs: number[] = [];
  for (const slot of members) {
    for (const [u, v] of slot.polygon_px) {
      us.push(u - cropU0);
      vs.push(v);
    }
  }
  // Thêm các làn cắt qua khung cam.
  //
  // **`aisle.polyline` là toạ độ world (mét), KHÔNG phải pixel** — phải chiếu bằng
  // `projectPoint` trước khi so với khung. (Bản đầu mình dùng thẳng làm u/v nên
  // cam2 hụt mất làn cổng ở x≈795/800; test `roiMaskCoverage.test.ts` bắt được.)
  for (const aisle of lot.aisles) {
    addWorldPoints(us, vs, lot.camera, crop, cropU0, aisle.polyline);
  }
  // Đoạn cổng vào/ra (BRIEF_P15 mục B nêu rõ): xe chạy từ `spawn` tới `despawn`, hai điểm này
  // thường nằm **ngoài khung** (vd cổng vào world x=44,98 → u=705 > 640 của cam2), nên phải kẹp
  // về mép khung để mask phủ hết đoạn đường xe chạy qua mép ảnh.
  for (const gate of [lot.gates.in, lot.gates.out]) {
    addWorldPoints(us, vs, lot.camera, crop, cropU0, [
      [gate.spawn[0], gate.spawn[1]],
      [gate.despawn[0], gate.despawn[1]],
      gate.p1,
      gate.p2,
    ]);
  }

  // Nới 2 px để mask không cắt mất mép (đơn vị **gốc**, trước khi nhân `scale`).
  const pad = 2;
  const size = techgarImageSize(scale);
  const minU = Math.max(0, Math.min(...us) - pad) * scale;
  const maxU = Math.min(TECHGAR_IMAGE.width, Math.max(...us) + pad) * scale;
  const minV = Math.max(0, Math.min(...vs) - pad) * scale;
  const maxV = Math.min(TECHGAR_IMAGE.height, Math.max(...vs) + pad) * scale;

  return {
    polygon: [
      { x: round4(minU), y: round4(minV) },
      { x: round4(maxU), y: round4(minV) },
      { x: round4(maxU), y: round4(maxV) },
      { x: round4(minU), y: round4(maxV) },
    ],
    image_size: [size.width, size.height],
  };
}

/** File `calibration.json` — đúng schema v5 của session toi1, **không** có `capture_manifest`. */
export interface CalibrationFile {
  readonly schema_version: 5;
  readonly calibration_id: string;
  readonly calibration_status: 'passed';
  readonly world: {
    readonly unit: string;
    readonly coordinate_system: string;
    readonly bounds: {
      readonly min_x_cm: number;
      readonly min_y_cm: number;
      readonly max_x_cm: number;
      readonly max_y_cm: number;
    };
    readonly full_view_bounds: {
      readonly min_x_cm: number;
      readonly min_y_cm: number;
      readonly max_x_cm: number;
      readonly max_y_cm: number;
    };
  };
  readonly camera_transforms: {
    readonly cam1: readonly (readonly number[])[];
    readonly cam2: readonly (readonly number[])[];
  };
  readonly camera_coverage_world: { readonly cam1: readonly GatePoint[]; readonly cam2: readonly GatePoint[] };
  readonly camera_full_view_world: { readonly cam1: readonly GatePoint[]; readonly cam2: readonly GatePoint[] };
  readonly parking_slots_world: {
    readonly cam1: readonly { readonly id: string; readonly polygon: readonly (readonly number[])[] }[];
    readonly cam2: readonly { readonly id: string; readonly polygon: readonly (readonly number[])[] }[];
  };
  readonly edge_adjacency: readonly {
    readonly source_camera: string;
    readonly exit_edge: string;
    readonly target_camera: string;
  }[];
  readonly overlap_world_polygon: readonly (readonly number[])[];
  readonly full_view_overlap_world_polygon: readonly (readonly number[])[];
  readonly tracking_defaults: typeof SAMPLE_TRACKING_DEFAULTS;
  readonly matching_defaults: typeof SAMPLE_MATCHING_DEFAULTS;
  readonly source: { readonly generator: string; readonly run_id: string; readonly scenario_hash: string };
  readonly recovery: { readonly method: string; readonly session: string };
}

/** Khung ảnh đầy đủ (640×640) → 4 góc theo một cam (dùng cho coverage/full view). */
function cameraCoverageWorld(
  lot: LotMap,
  crop: readonly [number, number],
  origin: Vec2,
  k: number,
): GatePoint[] {
  // Vùng cam thấy được = toàn khung cắt chiếu xuống mặt đất.
  const corners: readonly (readonly [number, number])[] = [
    [crop[0], 0],
    [crop[1], 0],
    [crop[1], TECHGAR_IMAGE.height],
    [crop[0], TECHGAR_IMAGE.height],
  ];
  return corners.map(([u, v]) => {
    const world = groundPoint(lot.camera, u, v);
    const point = toTechgarPoint(world, origin, k);
    return { x: round4(point[0]), y: round4(point[1]) };
  });
}

/**
 * Sinh `calibration.json` đầy đủ khoá (D3: "xuất đủ mọi khoá có trong schema 5").
 *
 * **Không** có `source.capture_manifest` — G0 A.2 và `REPORT_P0` (b): nếu có `width/height`
 * 1280×720 thì TechGAR kiểm tỉ lệ 16:9 và `raise` với khung 400×640.
 */
export function buildCalibration(
  lot: LotMap,
  origin: Vec2,
  k: number,
  runId: string,
  scenarioHash: string,
  scale = 1,
): CalibrationFile {
  const homography1 = imageToWorldHomography(
    lot.camera,
    CAMERA_CROPS.cam1[0],
    origin,
    k,
    scale,
  );
  const homography2 = imageToWorldHomography(
    lot.camera,
    CAMERA_CROPS.cam2[0],
    origin,
    k,
    scale,
  );
  const bounds = boundsOf(lot, origin, k);
  // Vùng nhìn đầy đủ: rộng hơn vùng ô một chút (mép bãi), đúng tinh thần session mẫu.
  const pad = 6 * k;
  return {
    schema_version: 5,
    calibration_id: `sim3d-${runId}`,
    calibration_status: 'passed',
    world: {
      unit: WORLD_UNIT,
      coordinate_system: 'measured_parking_ground_plane',
      bounds,
      full_view_bounds: {
        min_x_cm: round4(bounds.min_x_cm - pad),
        min_y_cm: round4(bounds.min_y_cm - pad),
        max_x_cm: round4(bounds.max_x_cm + pad),
        max_y_cm: round4(bounds.max_y_cm + pad),
      },
    },
    camera_transforms: {
      cam1: homography1.map((row) => row.map((value) => round12(value))),
      cam2: homography2.map((row) => row.map((value) => round12(value))),
    },
    camera_coverage_world: {
      cam1: cameraCoverageWorld(lot, CAMERA_CROPS.cam1, origin, k),
      cam2: cameraCoverageWorld(lot, CAMERA_CROPS.cam2, origin, k),
    },
    camera_full_view_world: {
      cam1: cameraCoverageWorld(lot, CAMERA_CROPS.cam1, origin, k),
      cam2: cameraCoverageWorld(lot, CAMERA_CROPS.cam2, origin, k),
    },
    parking_slots_world: {
      cam1: slotsWorld(lot, CAMERA_CROPS.cam1, origin, k),
      cam2: slotsWorld(lot, CAMERA_CROPS.cam2, origin, k),
    },
    // Loader so sánh **bằng nhau** dict này (REPORT_P0 (d) mục 3) ⇒ phải đúng 2 cặp.
    edge_adjacency: [
      { source_camera: 'cam1', exit_edge: 'right', target_camera: 'cam2' },
      { source_camera: 'cam2', exit_edge: 'left', target_camera: 'cam1' },
    ],
    overlap_world_polygon: overlapPolygon(CAMERA_CROPS.cam1[1], CAMERA_CROPS.cam2[0], lot, origin, k),
    full_view_overlap_world_polygon: overlapPolygon(
      CAMERA_CROPS.cam1[1],
      CAMERA_CROPS.cam2[0],
      lot,
      origin,
      k,
    ),
    tracking_defaults: SAMPLE_TRACKING_DEFAULTS,
    matching_defaults: SAMPLE_MATCHING_DEFAULTS,
    source: { generator: 'sim3d', run_id: runId, scenario_hash: scenarioHash },
    recovery: { method: 'sim3d_geometry', session: 'sim3d' },
  };
}

/** Làm tròn 12 chữ số cho homography (đủ chính xác, JSON không phình). */
function round12(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/** `parking_slots_world` cho một cam (polygon ở world unit). */
function slotsWorld(
  lot: LotMap,
  crop: readonly [number, number],
  origin: Vec2,
  k: number,
): { id: string; polygon: (readonly number[])[] }[] {
  return lot.slots
    .filter((slot) => belongsToCamera(slot, crop))
    .map((slot) => ({
      id: slot.id,
      polygon: slot.polygon.map((point) => {
        const [x, y] = toTechgarPoint(point, origin, k);
        return [round4(x), round4(y)];
      }),
    }));
}

/**
 * Đa giác vùng chồng lấn giữa hai cam (cột 240–400 px) chiếu xuống mặt đất.
 *
 * 4 góc của dải chồng lấn là đủ: `ground()` là phép chiếu phối cảnh nên cạnh vẫn thẳng.
 */
function overlapPolygon(
  u0: number,
  u1: number,
  lot: LotMap,
  origin: Vec2,
  k: number,
): (readonly number[])[] {
  const corners: readonly (readonly [number, number])[] = [
    [u0, 200],
    [u1, 200],
    [u1, 460],
    [u0, 460],
  ];
  return corners.map(([u, v]) => {
    const world = groundPoint(lot.camera, u, v);
    const [x, y] = toTechgarPoint(world, origin, k);
    return [round4(x), round4(y)];
  });
}

/** File `MANIFEST.json` (BE §5, D2: ghi `k` cụ thể). */
export interface ManifestFile {
  readonly session: string;
  readonly source: 'sim3d';
  readonly run_id: string;
  readonly scenario_hash: string;
  readonly generated_at: string;
  readonly world_unit: string;
  /** `k` = world unit / mét (D2, công thức G0 A.3). */
  readonly world_scale_k: number;
  /** Số liệu để người đọc kiểm chéo (G0 A.3). */
  readonly depth_check: {
    readonly sample_short_median: number;
    readonly sample_long_median: number;
    readonly slot_width_median_m: number;
    readonly slot_depth_median_m: number;
    readonly implied_depth_m: number;
    readonly relative_error: number;
    readonly tolerance: number;
  };
  readonly image_size: readonly [number, number];
  /** Hệ số phóng ảnh cam (BRIEF_P15): `image_size = 400×640 × scale`. */
  readonly image_scale: number;
  /** GT `_u/_v` ở cỡ gốc 640; nhân hệ số này để về không gian ảnh của run (= `image_scale`). */
  readonly gt_pixel_scale: number;
  readonly camera_membership_ratio: number;
  readonly files: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  /**
   * Vạch đếm so với vạch cổng **vẽ trên cảnh** (ANS_14/P11).
   *
   * `gate_zones.json` dùng **vạch đếm**, không dùng vạch cổng vẽ: cổng vẽ sát mép khung nên
   * tracker chưa kịp có Global ID khi xe đi qua (đo K2/K4/K6: 9/9 mẫu vào, 10/10 mẫu ra đều
   * cấp/mất ID sau khi đã qua cổng) ⇒ gate controller đếm 0. Toạ độ ở đây tính bằng **mét
   * world của sim** (trước khi nhân `k`), để người đọc đối chiếu với `lot_pucpr.json`.
   */
  readonly count_lines: {
    readonly note: string;
    readonly reason: string;
    readonly entry: { readonly drawn_m: readonly [number, number]; readonly count_m: readonly [number, number] };
    readonly exit: { readonly drawn_m: readonly [number, number]; readonly count_m: readonly [number, number] };
    readonly margin_m: number;
  };
}

/**
 * Sinh toàn bộ bộ config. Trả `null` khi chế độ 1 cam (ANS_1 A.1: **không** xuất config
 * vì TechGAR bắt buộc 2 cam) — không phải lỗi, nhưng phải nói rõ với người gọi.
 */
export function buildTechgarConfig(params: {
  readonly lot: LotMap;
  readonly cameraMode: CameraMode;
  readonly runId: string;
  readonly scenarioHash: string;
  readonly generatedAt: string;
  readonly warnings?: readonly string[];
  /** Vạch đếm dùng cho `gate_zones.json`; bỏ trống thì dẫn xuất từ `lot.gates`. */
  readonly countLines?: CountLines;
  /** Ô không đếm được cổng để liệt kê trong README (P11c mục 2). */
  readonly flaggedSlots?: readonly { readonly slot: string; readonly flag: string }[];
  /** Hệ số phóng ảnh cam cho TechGAR (BRIEF_P15 mục A). Mặc định `TECHGAR_SCALE`. */
  readonly scale?: number;
}): TechgarConfigBundle | null {
  const { lot, cameraMode, runId, scenarioHash, generatedAt } = params;
  if (cameraMode === '1cam') {
    return null;
  }
  if (lot.slots.length === 0) {
    throw new TechgarConfigError('buildTechgarConfig: lot không có ô nào');
  }

  const k = computeK(lot);
  const depthM = medianSlotDepthM(lot);
  const { implied, error } = checkDepthConsistency(k, depthM);
  const origin = lotCenter(lot);
  const countLines = params.countLines ?? buildCountLines(lot);
  const scale = params.scale ?? TECHGAR_SCALE;
  const size = techgarImageSize(scale);

  const calibration = buildCalibration(lot, origin, k, runId, scenarioHash, scale);
  const gateZones = buildGateZones(lot, origin, k, countLines);
  const slotsCam1 = slotsForCamera(lot, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0], scale);
  const slotsCam2 = slotsForCamera(lot, CAMERA_CROPS.cam2, CAMERA_CROPS.cam2[0], scale);
  const maskCam1 = buildRoiMask(lot, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0], scale);
  const maskCam2 = buildRoiMask(lot, CAMERA_CROPS.cam2, CAMERA_CROPS.cam2[0], scale);

  const warnings = [...(params.warnings ?? [])];
  // Ô không thuộc cam nào là bất thường: cảnh báo, không im lặng.
  const orphan = lot.slots.filter(
    (slot) => !belongsToCamera(slot, CAMERA_CROPS.cam1) && !belongsToCamera(slot, CAMERA_CROPS.cam2),
  );
  if (orphan.length > 0) {
    warnings.push(
      `ô không thuộc cam nào (bỏ khỏi cả hai file slots): ${orphan.map((slot) => slot.id).join(', ')}`,
    );
  }
  // Ô chỉ thuộc một cam (không ở vùng chồng) — thông tin, không phải lỗi.
  const onlyCam1 = lot.slots.filter(
    (slot) => belongsToCamera(slot, CAMERA_CROPS.cam1) && !belongsToCamera(slot, CAMERA_CROPS.cam2),
  ).length;
  const onlyCam2 = lot.slots.filter(
    (slot) => belongsToCamera(slot, CAMERA_CROPS.cam2) && !belongsToCamera(slot, CAMERA_CROPS.cam1),
  ).length;
  const both = lot.slots.filter(
    (slot) => belongsToCamera(slot, CAMERA_CROPS.cam1) && belongsToCamera(slot, CAMERA_CROPS.cam2),
  ).length;

  const manifest: ManifestFile = {
    session: `sim3d-${runId}`,
    source: 'sim3d',
    run_id: runId,
    scenario_hash: scenarioHash,
    generated_at: generatedAt,
    world_unit: WORLD_UNIT,
    world_scale_k: round4(k),
    depth_check: {
      sample_short_median: SAMPLE_SLOT_SHORT_MEDIAN,
      sample_long_median: SAMPLE_SLOT_LONG_MEDIAN,
      slot_width_median_m: round4(medianSlotWidthM(lot)),
      slot_depth_median_m: round4(depthM),
      implied_depth_m: round4(implied),
      relative_error: round4(error),
      tolerance: DEPTH_CHECK_TOLERANCE,
    },
    image_size: [size.width, size.height],
    image_scale: scale,
    gt_pixel_scale: scale,
    camera_membership_ratio: CAM_MEMBERSHIP_RATIO,
    count_lines: {
      note:
        'gate_zones.json dùng VẠCH ĐẾM (count line), KHÔNG phải vạch cổng vẽ trên cảnh. ' +
        'Toạ độ dưới đây là mét world của sim (chưa nhân k).',
      reason:
        'Vạch cổng vẽ sát mép khung; tracker chỉ cấp Global ID sau vài frame nên xe đã qua ' +
        'cổng trước khi có ID ⇒ gate_session_controller không thấy cú cắt nào và đếm 0. ' +
        'Vạch đếm đặt sâu hơn (đo từ K2/K4/K6) để mọi xe đã có ID trước khi cắt.',
      entry: {
        drawn_m: [round4(lot.gates.in.p1[0]), round4(lot.gates.in.p2[0])],
        count_m: [round4(countLines.entry.p1[0]), round4(countLines.entry.p2[0])],
      },
      exit: {
        drawn_m: [round4(lot.gates.out.p1[0]), round4(lot.gates.out.p2[0])],
        count_m: [round4(countLines.exit.p1[0]), round4(countLines.exit.p2[0])],
      },
      margin_m: COUNT_LINE_MARGIN_M,
    },
    files: {
      calibration: 'calibration.json',
      slots_cam1: 'parking_slots_cam1.json',
      slots_cam2: 'parking_slots_cam2.json',
      gate_zones: 'gate_zones.json',
      mask_cam1: 'roi_mask_cam1.json',
      mask_cam2: 'roi_mask_cam2.json',
      readme: 'README.txt',
    },
    warnings,
  };

  const files: ConfigFile[] = [
    { path: 'calibration.json', text: toJson(calibration) },
    { path: 'parking_slots_cam1.json', text: toJson(slotsCam1) },
    { path: 'parking_slots_cam2.json', text: toJson(slotsCam2) },
    { path: 'gate_zones.json', text: toJson(gateZones) },
    { path: 'roi_mask_cam1.json', text: toJson(maskCam1) },
    { path: 'roi_mask_cam2.json', text: toJson(maskCam2) },
    { path: 'MANIFEST.json', text: toJson(manifest) },
    {
      path: 'README.txt',
      text: buildReadme({
        runId,
        k,
        implied,
        depthM,
        error,
        onlyCam1,
        onlyCam2,
        both,
        warnings,
        orphanCount: orphan.length,
        imageWidth: size.width,
        imageHeight: size.height,
        imageScale: scale,
        ...(params.flaggedSlots === undefined ? {} : { flaggedSlots: params.flaggedSlots }),
        countLines: {
          entry: {
            drawn: round4(lot.gates.in.p1[0]),
            count: round4(countLines.entry.p1[0]),
          },
          exit: {
            drawn: round4(lot.gates.out.p1[0]),
            count: round4(countLines.exit.p1[0]),
          },
        },
      }),
    },
  ];

  return { files, k, slotDepthM: depthM, impliedDepthM: implied, depthError: error };
}

/** JSON ổn định: 4 dấu cách thụt lề + newline cuối (diff được, hash ổn định). */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

/**
 * Nội dung `README.txt`: lệnh chạy đầy đủ + kết luận về gate (ANS_1 A.4).
 *
 * Kết luận gate: `runtime_server.py` **chỉ** đọc `config/gate_zones.json` trong repo
 * (`runtime_server.py:22`, `:316`) để phục vụ `/api/runtime/gates` và endpoint PUT;
 * phần đếm vào/ra + GID nằm ở `gate_session_controller.py` và nó nhận `--gate-config`.
 * Vì vậy gate của sim **có** ảnh hưởng chỉ số đếm vào/ra, nhưng chỉ qua
 * `gate_session_controller`; `runtime_server` không dùng nó để tính chỉ số.
 */
export function buildReadme(params: {
  readonly runId: string;
  readonly k: number;
  readonly implied: number;
  readonly depthM: number;
  readonly error: number;
  readonly onlyCam1: number;
  readonly onlyCam2: number;
  readonly both: number;
  readonly orphanCount: number;
  /** Kích thước ảnh cam thực dùng (sau khi nhân hệ số `s`). */
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly imageScale?: number;
  readonly warnings: readonly string[];
  /** Vạch cổng vẽ + vạch đếm (ANS_14/P11); bỏ trống thì không in bảng so sánh. */
  readonly countLines?: {
    readonly entry: { readonly drawn: number; readonly count: number };
    readonly exit: { readonly drawn: number; readonly count: number };
  };
  /**
   * Ô không đếm được cổng (P11c mục 2). Rỗng = không ô nào bị cờ.
   */
  readonly flaggedSlots?: readonly { readonly slot: string; readonly flag: string }[];
}): string {
  const dir = `<RUN_DIR>\\techgar_config`;
  const lines = [
    `SIM3D — bộ config TechGAR cho lần xuất "${params.runId}"`,
    '',
    'NGUỒN: web SIM3D sinh từ hình học mô phỏng (không phải calibration camera thật).',
    'Chỉ dùng cho kết quả "GT sim3d"; không gộp với số liệu P1/P2 của bộ cũ (D10).',
    '',
    '## Số liệu chính',
    `- Khung ảnh mỗi cam: ${String(params.imageWidth ?? TECHGAR_IMAGE.width)}×${String(params.imageHeight ?? TECHGAR_IMAGE.height)} ` +
      `(= 400×640 × hệ số **s = ${String(params.imageScale ?? 1)}**, BRIEF_P15).`,
    `- Đơn vị world: "${WORLD_UNIT}" nhưng là cm trên bãi mô hình thu nhỏ (D2).`,
    `- k = ${params.k.toFixed(6)} world unit / mét (công thức G0 A.3: 5,116 / bề rộng ô trung vị).`,
    `- Kiểm chéo G0 A.3: 9,249 / k = ${params.implied.toFixed(3)} m so với chiều sâu ô ` +
      `${params.depthM.toFixed(3)} m → lệch ${(params.error * 100).toFixed(1)} % ` +
      `(ngưỡng ${String(DEPTH_CHECK_TOLERANCE * 100)} %).`,
    `- Ô thuộc cam1: ${String(params.onlyCam1)} chỉ cam1 · ${String(params.both)} vùng chồng ` +
      `(có ở cả hai file) · ${String(params.onlyCam2)} chỉ cam2 · ${String(params.orphanCount)} không thuộc cam nào.`,
    '',
    '## Lệnh chạy (PowerShell, đường dẫn tuyệt đối)',
    '',
    'Bước 1 — runtime_server (replay 2 camera):',
    '',
    '`runtime_server.py` **không có** cờ `--cam1-video/--cam2-video`. Cờ thật để replay từ thư mục',
    'đã xuất là `--replay-session <RUN_DIR>`: thư mục đó phải có `raw_cam1.mp4`, `raw_cam2.mp4` và',
    '`frame_timestamps.csv` (đúng tên — `run_two_camera_session._resolve_raw_session`).',
    '',
    '```powershell',
    '$VENV   = "D:\\TechGar2\\backend\\main_detect\\.venv\\Scripts\\python.exe"',
    '$SERVER = "D:\\TechGar2\\backend\\main_detect\\runtime_server.py"',
    `$CFG    = "${dir}"   # thay <RUN_DIR> bằng thư mục lần xuất`,
    '$VID    = "<RUN_DIR>"   # raw_cam1.mp4, raw_cam2.mp4, frame_timestamps.csv',
    '',
    '& $VENV $SERVER `',
    '  --replay-session "$VID" `',
    '  --slots-cam1 "$CFG\\parking_slots_cam1.json" `',
    '  --slots-cam2 "$CFG\\parking_slots_cam2.json" `',
    '  --calibration "$CFG\\calibration.json" `',
    '  --mask-cam1 "$CFG\\roi_mask_cam1.json" `',
    '  --mask-cam2 "$CFG\\roi_mask_cam2.json" `',
    '  --detector-profile "D:\\TechGar2\\backend\\main_detect\\config\\two_camera.detector.json" `',
    '  --output-dir "<RUN_DIR>\\runtime" `',
    '  --session-dir "<RUN_DIR>\\runtime_session" `',
    '  --api-port 8001 --no-display --live-mode',
    '```',
    '',
    '`--session-dir` phải là thư mục **chưa tồn tại**; nếu đã có thì đổi tên.',
    '',
    '**`--live-mode` nằm trong lệnh trên** vì README này mô tả luồng đầy đủ (replay + đếm cổng).',
    'Nếu **chỉ** replay mà không chạy Bước 2 thì bỏ cờ đó đi — khi đó snapshot mang',
    '`source_mode="replay"` cho đúng sự thật.',
    '',
    'Vì sao cần: `gate_session_controller.py` có `_fresh_live` (dòng 103-104) **bỏ qua** mọi',
    'snapshot có `source_mode != "live"`. Replay mặc định phát `source_mode="replay"`',
    '(`two_camera.py:2864`), nên **thiếu `--live-mode` thì controller đếm 0 lượt mà không báo lỗi**',
    '— im lặng, đúng thứ R2 cấm.',
    '',
    'Bước 2 — gate_session_controller (đếm vào/ra + Global-ID):',
    '',
    '```powershell',
    '& $VENV "D:\\TechGar2\\backend\\gate_session_controller.py" `',
    '  --runtime-url "http://127.0.0.1:8001/api/runtime/snapshot" `',
    '  --gate-config "$CFG\\gate_zones.json" `',
    '  --port 8000',
    '```',
    '',
    '> **`gate_session_controller.py` KHÔNG có cờ `--live-mode`.** `parser()` của nó (dòng 855-868)',
    '> chỉ nhận `--source`, `--runtime-url`, `--gate-config`, `--port`, `--poll-interval`,',
    '> `--parked-confirm-seconds`. Thêm `--live-mode` vào lệnh này là argparse **lỗi ngay**.',
    '> Cờ đó thuộc về **runtime_server** (Bước 1) — đã có sẵn trong lệnh Bước 1 ở trên.',
    '',
    'Số lượt vào/ra: controller in ra stdout mỗi lượt một dòng `[ENTRY] Global ID #… -> session …`',
    'hoặc `[EXIT] Global ID #… -> deleted session …`. Muốn tự động so với `gt_events.csv` thì dùng',
    '`sim3d/tools/m1_gate_eval.py <RUN_DIR>` (nó tự thêm `--live-mode` cho runtime và ghi',
    '`<RUN_DIR>/m1_gate/gate_result.json`).',
    '',
    '**Chuyện bình thường khi replay hết frame:** `runtime_server` đóng cổng 8001 ngay khi replay',
    'xong, nên lần poll kế tiếp của controller in ra `ConnectionResetError: [WinError 10054]` và',
    'dừng. Đó là **dọn dẹp sau khi đã xong**, không phải lỗi đếm — số `[ENTRY]`/`[EXIT]` in trước',
    'đó vẫn đúng. Muốn controller sống lâu hơn thì bật `--replay-realtime` cho runtime (chạy theo',
    'timestamp thật, chậm hơn nhưng controller kịp poll từng frame).',
    '',
    '## `gate_zones.json` dùng **VẠCH ĐẾM**, không phải vạch cổng vẽ (P11 / ANS_14)',
    '',
    '**Đọc kỹ mục này** nếu bạn thắc mắc tại sao toạ độ trong `gate_zones.json` không trùng cổng',
    'nhìn thấy trên cảnh.',
    '',
    'Vạch cổng **vẽ** nằm sát mép khung (`u = 630` vào, `u = 4` ra ở ảnh 640). TechGAR chỉ cấp',
    'Global ID sau khi tracker bám được vài frame, nên **lúc có ID thì xe đã đi qua vạch cổng**',
    'rồi. Đo trên 3 run K2/K4/K6 (19 mẫu):',
    '',
    '- **9/9** mẫu cấp Global ID khi vào đều ở `x = +25,82 .. +31,89` m — trong khi cổng vẽ ở',
    '  `x = +36,21` m.',
    '- **10/10** mẫu mất Global ID khi ra đều ở `x = −34,93 .. −25,93` m — trong khi cổng vẽ ở',
    '  `x = −36,92` m.',
    '',
    'Vì vậy `gate_session_controller` **không thấy cú cắt cổng nào** và đếm **0** (đo ở P10e).',
    'Hệ thống thật cũng phải đặt vạch đếm ở chỗ tracker **đã có ID** — vạch sát mép khung là lỗi',
    'cấu hình, không phải giới hạn của TechGAR.',
    '',
    'Nên file này dùng **vạch đếm**:',
    '',
    '| | Vạch cổng vẽ (m) | **Vạch đếm** (m) | Ghi chú |',
    '|---|---|---|---|',
    `| Vào | \`x = ${String(params.countLines?.entry.drawn ?? '?')}\` | \`x = ${String(params.countLines?.entry.count ?? '?')}\` | sâu hơn điểm cấp ID muộn nhất (+25,82) thêm 1 chiều dài xe (5,17 m) |`,
    `| Ra  | \`x = ${String(params.countLines?.exit.drawn ?? '?')}\` | \`x = ${String(params.countLines?.exit.count ?? '?')}\` | nông hơn điểm mất ID sớm nhất (−25,93) bớt 1 chiều dài xe |`,
    '',
    `Biên an toàn còn **${String(COUNT_LINE_MARGIN_M)} m** mỗi bên. Xe đi từ \`+x\` sang \`−x\` (C6: hướng tây),`,
    'nên `direction` vẫn đúng chiều như cổng vẽ.',
    '',
    '**Cổng vẽ, `lot_pucpr.json` và các làn KHÔNG bị sửa** — chỉ vạch dùng để đếm là khác. Luật',
    'kiểu L-GATE cũng kiểm cho vạch đếm: tại `x = ±20,05` m, mọi làn khác lối vào/ra cách',
    '**≥ 10,0 m** (ngưỡng là 2,0 m), nên không xe nào ngoài luồng vào/ra cắt vạch.',
    '',
    '**GT dùng cùng vạch này**: `gate_in_frame`/`gate_out_frame` trong `gt_events.csv` là frame',
    'tâm xe cắt **vạch đếm**, không phải vạch cổng vẽ. Nhờ vậy GT và `gate_zones.json` luôn khớp',
    'nhau (cùng một nguồn `export/countLines.ts`).',
    '',
    '## Ô không đếm được cổng (P11c / ANS_17)',
    '',
    'Đây là hệ quả của hình học bãi, **không phải lỗi tracker** và **không phải lỗi video**:',
    'lộ trình một chiều của bãi đi vòng qua tâm bãi (A2→V_west→A1→V_east→A2), nên với nhiều ô xe',
    'cắt vạch đếm 0 hoặc nhiều lần; ngoài ra camera không phủ đoạn A3 quanh x = ±20 nên',
    'xe hàng 5 không được cấp/giữ Global ID ở đó.',
    '',
    'Xe vào/ra ở các ô dưới đây vẫn hợp lệ, nhưng `gt_events.csv` để **rỗng**',
    '`gate_in_frame`/`gate_out_frame` và ghi lý do ở cột `gate_note`. Đừng dùng những cột đó để',
    'đánh giá đếm cổng cho xe ở các ô này.',
    '',
    ...(params.flaggedSlots === undefined || params.flaggedSlots.length === 0
      ? ['(không có ô nào bị cờ trong lần xuất này)', '']
      : [
          `Tổng **${String(params.flaggedSlots.length)}** ô:`,
          '',
          ...params.flaggedSlots.map((item) => `- \`${item.slot}\` — \`${item.flag}\``),
          '',
        ]),

    '## Hai loại GT — đọc đúng file trước khi kết luận (ANS_18)',
    '',
    'Bộ này có **hai** file GT cột cổng, trả lời hai câu hỏi khác nhau:',
    '',
    '| File | Câu hỏi | Cột |',
    '|---|---|---|',
    '| `gt_events.csv` | **Ngữ nghĩa:** xe có thật sự vào/ra bãi không? | `gate_in_frame`, `gate_out_frame`, `gate_note` |',
    '| `gt_gate_ideal.csv` | **Lý tưởng:** một tracker hoàn hảo đi qua đúng bộ đếm của TechGAR sẽ đếm bao nhiêu? | `car_id, frame, kind, visible` |',
    '',
    '**Chênh giữa hai loại là giới hạn do vị trí vạch đếm / vùng camera, KHÔNG phải lỗi tracker.**',
    'Cụ thể:',
    '',
    '- Nếu một xe có `gate_note` (rỗng cột cổng) thì nó vẫn **có thể** có mặt trong',
    '  `gt_gate_ideal.csv` — vì bộ đếm lý tưởng chạy trên quỹ đạo thật, không phụ thuộc cột của',
    '  `gt_events`.',
    '- Dòng `visible=0` nghĩa là camera **không thấy** điểm cắt đó, nên về lý thuyết TechGAR không thể',
    '  đếm được. Chỉ dùng dòng `visible=1` khi so với số TechGAR đếm.',
    '',
    'Vì vậy khi đo: so **TechGAR với `gt_gate_ideal` (visible=1)** là phép so công bằng nhất;',
    'còn `gt_events` cho biết mất bao nhiêu vì hình học bãi.',
    '',
    '## Gate có ảnh hưởng chỉ số không? (ANS_1 A.4)',
    '',
    '**Có, nhưng chỉ qua `gate_session_controller`** — kết luận sau khi đọc code:',
    '- `backend/main_detect/runtime_server.py:22` khai `DEFAULT_GATE_CONFIG = config/gate_zones.json`',
    '  **trong repo**; dòng `:316` chỉ đọc file này để trả `/api/runtime/gates` và nhận PUT.',
    '  `runtime_server.py` **không** tính lượt vào/ra, không dùng gate để sinh dữ liệu ảnh.',
    '- Việc đếm vào/ra + GID nằm ở `backend/gate_session_controller.py`: `--gate-config` (`:863`),',
    '  `get_crossing_direction` (`:242-256`), và nó so `unit` của gate với `unit` của snapshot',
    '  (`:405-410`) — nên gate **phải** cùng đơn vị world với `calibration.json`.',
    '',
    '→ **Không cần sao lưu/chép gì vào `backend/`**: chỉ cần truyền `--gate-config` tuyệt đối',
    'như lệnh trên. Nếu dùng `frontend/` (MonitorApp) thì nó đọc gate từ `runtime_server`',
    '(file trong repo) — lúc đó gate của sim **không** hiện trên UI, nhưng chỉ số đếm vẫn đúng',
    'vì nó do `gate_session_controller` tính.',
    '',
    '## Ghi chú',
    '- `calibration.json` **cố ý không có** `source.capture_manifest`: nếu có `width/height`',
    '  1280×720 thì TechGAR kiểm tỉ lệ 16:9 và `raise` với khung 400×640 (`REPORT_P0` (b)).',
    '- `tracking_defaults` / `matching_defaults` chép nguyên từ session mẫu',
    '  `droidcam_shared_toi1` (D2/D3), không suy diễn thêm.',
    '- `roi_mask_cam*.json` vẽ đúng 400×640: loader **không** co mask theo `image_size`',
    '  (`REPORT_P0` (b) mục 3).',
    '- Mã ô `S001`…`S100`: loader/detector không kiểm định dạng id, chỉ là nhãn chuỗi',
    '  (`REPORT_P0` (f)). Kiosk `frontend/` thì có hard-code id nên sẽ không hiện — sim3d không dùng kiosk.',
  ];
  if (params.warnings.length > 0) {
    lines.push('', '## Cảnh báo khi sinh config');
    for (const warning of params.warnings.slice(0, MAX_WARNINGS)) {
      lines.push(`- ${warning}`);
    }
    if (params.warnings.length > MAX_WARNINGS) {
      lines.push(`- … và ${String(params.warnings.length - MAX_WARNINGS)} cảnh báo nữa (xem MANIFEST.json).`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** `visibleRatioInCamera` xuất lại cho test/UI tiện dùng. */
export { visibleRatioInCamera };

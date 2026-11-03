/**
 * Test sinh `techgar_config/` (P7a mục 1, G0/`ANS_1` A).
 *
 * Dùng `lot` **thật** (`data/lot/lot_pucpr.json`) để kiểm cả số liệu thật (k, kiểm chéo
 * chiều sâu) chứ không chỉ fixture giả.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import {
  CAM_MEMBERSHIP_RATIO,
  DEPTH_CHECK_TOLERANCE,
  SAMPLE_MATCHING_DEFAULTS,
  SAMPLE_SLOT_LONG_MEDIAN,
  SAMPLE_SLOT_SHORT_MEDIAN,
  SAMPLE_TRACKING_DEFAULTS,
  TECHGAR_IMAGE,
  TechgarConfigError,
  applyHomography,
  boundsOf,
  checkDepthConsistency,
  computeK,
  groundPoint,
  homographyFromFourPoints,
  imageToWorldHomography,
  lotCenter,
  median,
  medianSlotDepthM,
  medianSlotWidthM,
  solveLinearSystem,
  toTechgarPoint,
  techgarImageSize,
  TECHGAR_SCALE,
} from './techgarConfig';
import {
  CAMERA_CROPS,
  buildGateZones,
  buildRoiMask,
  buildTechgarConfig,
  buildReadme,
} from './techgarBundle';
import { belongsToCamera, polygonArea, slotsForCamera, visibleRatioInCamera } from './slotsByCamera';

const LOT: LotMap = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'data', 'lot', 'lot_pucpr.json'), 'utf8'),
) as LotMap;

const RUN_ID = '20261031-120000_test';
const SCENARIO_HASH = 'sha256:abc123';
const GENERATED_AT = '2026-10-31T05:00:00Z';

function bundle() {
  const result = buildTechgarConfig({
    lot: LOT,
    cameraMode: '2cam',
    runId: RUN_ID,
    scenarioHash: SCENARIO_HASH,
    generatedAt: GENERATED_AT,
  });
  if (result === null) {
    throw new Error('buildTechgarConfig trả null cho 2cam — sai');
  }
  return result;
}

function fileOf(files: readonly { path: string; text: string }[], path: string): string {
  const found = files.find((file) => file.path === path);
  if (found === undefined) {
    throw new Error(`không có file ${path} trong bộ config`);
  }
  return found.text;
}

// --------------------------------------------------------------------------------------
// k và kiểm chéo G0 A.3
// --------------------------------------------------------------------------------------
describe('export/techgarConfig — k theo G0 A.3', () => {
  it('k = 5,116 / bề rộng ô trung vị (m)', () => {
    const widthM = medianSlotWidthM(LOT);
    expect(computeK(LOT)).toBeCloseTo(SAMPLE_SLOT_SHORT_MEDIAN / widthM, 12);
    // Bề rộng trung vị của bãi P2b nằm trong dải hợp lý.
    expect(widthM).toBeGreaterThan(2.0);
    expect(widthM).toBeLessThan(3.0);
  });

  it('k thực tế nằm trong khoảng hợp lý với bãi ~2,3–2,9 m', () => {
    const k = computeK(LOT);
    expect(k).toBeGreaterThan(1.5);
    expect(k).toBeLessThan(2.6);
  });

  it('kiểm chéo 9,249 / k ≈ chiều sâu ô trung vị, lệch ≤ 20 %', () => {
    const k = computeK(LOT);
    const depthM = medianSlotDepthM(LOT);
    const { implied, error } = checkDepthConsistency(k, depthM);
    expect(implied).toBeCloseTo(SAMPLE_SLOT_LONG_MEDIAN / k, 12);
    expect(error).toBeLessThanOrEqual(DEPTH_CHECK_TOLERANCE);
    // Số thật để REPORT dẫn được.
    expect(error).toBeLessThan(0.2);
  });

  it('kiểm chéo lệch > 20 % thì ném lỗi rõ ràng, không im lặng (G0)', () => {
    expect(() => checkDepthConsistency(1.0, 2.0)).toThrow(TechgarConfigError);
    expect(() => checkDepthConsistency(1.0, 2.0)).toThrow(/Kiểm chéo G0 A\.3 thất bại/);
    expect(() => checkDepthConsistency(1.0, 2.0)).toThrow(/9,249 \/ k/);
  });

  it('median rỗng là lỗi (R2)', () => {
    expect(() => median([])).toThrow(/rỗng/);
  });

  it('median số chẵn lấy trung bình hai giữa', () => {
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
  });
});

// --------------------------------------------------------------------------------------
// Homography: phải khớp ground()/project() chính xác
// --------------------------------------------------------------------------------------
describe('export/techgarConfig — homography ảnh → world', () => {
  it('groundPoint khớp công thức build_blender_video.py (điểm tâm ảnh)', () => {
    // v = 320 ⇒ t = 0 ⇒ Y = H·cos/sin = 33.6·cos80°/sin80°; X = 0.
    const [x, y] = groundPoint(LOT.camera, 320, 320);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo((LOT.camera.height_m * Math.cos(Math.PI / 180 * 80)) / Math.sin(Math.PI / 180 * 80), 9);
  });

  it('homography tái tạo groundPoint tại nhiều điểm (cả 2 cam)', () => {
    const origin = lotCenter(LOT);
    const k = computeK(LOT);
    for (const [name, crop] of Object.entries(CAMERA_CROPS)) {
      const h = imageToWorldHomography(LOT.camera, crop[0], origin, k);
      for (const [u, v] of [
        [0, 0],
        [400, 0],
        [400, 640],
        [0, 640],
        [200, 320],
        [37, 517],
        [381, 91],
      ]) {
        // (u, v) là toạ độ trong khung cắt ⇒ đổi về khung 640 trước khi so.
        const expected = toTechgarPoint(groundPoint(LOT.camera, u + crop[0], v), origin, k);
        const got = applyHomography(h, [u, v]);
        expect(got[0], `${name} u=${String(u)} v=${String(v)}`).toBeCloseTo(expected[0], 6);
        expect(got[1], `${name} u=${String(u)} v=${String(v)}`).toBeCloseTo(expected[1], 6);
      }
    }
  });

  it('homographyFromFourPoints tái tạo đúng 4 điểm dùng để dựng', () => {
    const src: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const dst: [number, number][] = [[1, 2], [5, 3], [6, 9], [0, 8]];
    const h = homographyFromFourPoints(src, dst);
    for (let index = 0; index < 4; index += 1) {
      const got = applyHomography(h, src[index]);
      expect(got[0]).toBeCloseTo(dst[index][0], 9);
      expect(got[1]).toBeCloseTo(dst[index][1], 9);
    }
  });

  it('solveLinearSystem giải hệ 2×2 đơn giản', () => {
    // 2x + y = 5; x - y = 1 ⇒ x = 2, y = 1.
    expect(solveLinearSystem([[2, 1, 5], [1, -1, 1]])).toEqual([2, 1]);
  });

  it('solveLinearSystem ném lỗi khi suy biến (R2)', () => {
    expect(() => solveLinearSystem([[1, 2, 3], [2, 4, 6]])).toThrow(/suy biến/);
  });

  it('boundsOf bao đúng mọi ô và gốc là tâm bãi', () => {
    const origin = lotCenter(LOT);
    const k = computeK(LOT);
    const bounds = boundsOf(LOT, origin, k);
    expect(bounds.max_x_cm).toBeGreaterThan(bounds.min_x_cm);
    expect(bounds.max_y_cm).toBeGreaterThan(bounds.min_y_cm);
    // Gốc là tâm bãi ⇒ khung bao gần đối xứng qua 0.
    expect(Math.abs(bounds.min_x_cm + bounds.max_x_cm)).toBeLessThan(1e-3 * k * 100);
  });
});

// --------------------------------------------------------------------------------------
// Chia ô theo cam (>= 80 %)
// --------------------------------------------------------------------------------------
describe('export/slotsByCamera — chia ô theo cam', () => {
  it('polygonArea đúng với hình vuông 10×10', () => {
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeCloseTo(100, 9);
  });

  it('ô nằm trọn trong cam1 ⇒ tỉ lệ 1; ngoài ⇒ 0', () => {
    const slot = LOT.slots[0];
    expect(visibleRatioInCamera(slot, [0, 640])).toBeCloseTo(1, 9);
    // Khung hoàn toàn ngoài ô ⇒ 0.
    const far = slot.polygon_px.reduce((max, [, v]) => Math.max(max, v), 0);
    expect(visibleRatioInCamera(slot, [0, 1])).toBeGreaterThanOrEqual(0);
    expect(far).toBeGreaterThan(0);
  });

  it('ngưỡng đúng 80 % (BE §5)', () => {
    expect(CAM_MEMBERSHIP_RATIO).toBe(0.8);
  });

  it('không ô nào bị bỏ khỏi cả hai file, và mọi id hợp lệ', () => {
    const cam1 = slotsForCamera(LOT, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0]);
    const cam2 = slotsForCamera(LOT, CAMERA_CROPS.cam2, CAMERA_CROPS.cam2[0]);
    const ids1 = new Set(cam1.slots.map((slot) => slot.id));
    const ids2 = new Set(cam2.slots.map((slot) => slot.id));
    const orphans = LOT.slots.filter((slot) => !ids1.has(slot.id) && !ids2.has(slot.id));
    expect(orphans.map((slot) => slot.id)).toEqual([]);
    for (const id of [...ids1, ...ids2]) {
      expect(id).toMatch(/^S\d{3}$/);
    }
  });

  it('ô ở vùng chồng lấn có mặt ở CẢ HAI file với cùng id (BE §5)', () => {
    const cam1 = slotsForCamera(LOT, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0]);
    const cam2 = slotsForCamera(LOT, CAMERA_CROPS.cam2, CAMERA_CROPS.cam2[0]);
    const ids1 = new Set(cam1.slots.map((slot) => slot.id));
    const ids2 = new Set(cam2.slots.map((slot) => slot.id));
    const both = [...ids1].filter((id) => ids2.has(id));
    expect(both.length).toBeGreaterThan(0);
    // Polygon của cùng ô ở hai file phải khác nhau (lệch 240 px) nhưng cùng id.
    for (const id of both.slice(0, 5)) {
      const s1 = cam1.slots.find((slot) => slot.id === id);
      const s2 = cam2.slots.find((slot) => slot.id === id);
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
      expect(s1!.polygon.length).toBe(4);
      expect(s2!.polygon.length).toBe(4);
      const dx = s1!.polygon[0].x - s2!.polygon[0].x;
      expect(Math.abs(dx - 240)).toBeLessThan(1e-6);
    }
  });

  it('file slots ghi đúng 400×640 (không phải 1280×720)', () => {
    for (const crop of [CAMERA_CROPS.cam1, CAMERA_CROPS.cam2] as const) {
      const file = slotsForCamera(LOT, crop, crop[0]);
      expect(file.imageWidth).toBe(400);
      expect(file.imageHeight).toBe(640);
      expect([file.imageWidth, file.imageHeight]).toEqual([TECHGAR_IMAGE.width, TECHGAR_IMAGE.height]);
    }
  });

  it('toạ độ polygon trong khung cắt nằm quanh [0, 400] × [0, 640]', () => {
    // Ô thuộc cam khi ≥ 80 % diện tích nằm trong khung, nên mép ô **có thể** thò ra ngoài
    // khung (tối đa ~20 % bề rộng). Giữ toạ độ thật (không cắt cụt) để TechGAR vẽ đúng
    // hình ô; chỉ kiểm phần lớn nằm trong khung và không lệch vô lý.
    for (const crop of [CAMERA_CROPS.cam1, CAMERA_CROPS.cam2] as const) {
      const file = slotsForCamera(LOT, crop, crop[0]);
      for (const slot of file.slots) {
        const inside = slot.polygon.filter(
          (point) => point.x >= -0.01 && point.x <= 400.01 && point.y >= 0 && point.y <= 640,
        ).length;
        // Ít nhất 2/4 góc phải nằm trong khung (≥ 80 % diện tích ⇒ thực tế là 3–4 góc).
        expect(inside, `${slot.id} chỉ có ${String(inside)}/4 góc trong khung`).toBeGreaterThanOrEqual(2);
        for (const point of slot.polygon) {
          expect(point.x).toBeGreaterThan(-80);
          expect(point.x).toBeLessThan(480);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(640);
        }
      }
    }
  });

  it('belongsToCamera khớp ngưỡng 80 %', () => {
    for (const slot of LOT.slots) {
      const ratio = visibleRatioInCamera(slot, CAMERA_CROPS.cam1);
      expect(belongsToCamera(slot, CAMERA_CROPS.cam1)).toBe(ratio >= 0.8);
    }
  });
});

// --------------------------------------------------------------------------------------
// Bộ config đầy đủ
// --------------------------------------------------------------------------------------
describe('export/techgarBundle — bộ techgar_config', () => {
  it('2 cam ⇒ đủ 8 file, đúng tên BE §5', () => {
    const { files } = bundle();
    expect(files.map((file) => file.path).sort()).toEqual([
      'MANIFEST.json',
      'README.txt',
      'calibration.json',
      'gate_zones.json',
      'parking_slots_cam1.json',
      'parking_slots_cam2.json',
      'roi_mask_cam1.json',
      'roi_mask_cam2.json',
    ]);
  });

  it('1 cam ⇒ KHÔNG xuất techgar_config (ANS_1 A.1)', () => {
    const result = buildTechgarConfig({
      lot: LOT,
      cameraMode: '1cam',
      runId: RUN_ID,
      scenarioHash: SCENARIO_HASH,
      generatedAt: GENERATED_AT,
    });
    expect(result).toBeNull();
  });

  it('tất cả file JSON parse được (verify của BE mục 4 sẽ kiểm)', () => {
    const { files } = bundle();
    for (const file of files) {
      if (!file.path.endsWith('.json')) {
        continue;
      }
      const parsed: unknown = JSON.parse(file.text);
      expect(parsed, file.path).toBeTypeOf('object');
    }
  });

  it('calibration KHÔNG có source.capture_manifest (G0 A.2)', () => {
    const calibration = JSON.parse(fileOf(bundle().files, 'calibration.json')) as {
      source: Record<string, unknown>;
      schema_version: number;
      calibration_status: string;
    };
    expect(calibration.schema_version).toBe(5);
    expect(calibration.calibration_status).toBe('passed');
    expect(calibration.source).not.toHaveProperty('capture_manifest');
    expect(calibration.source).toHaveProperty('generator', 'sim3d');
    expect(calibration.source).toHaveProperty('run_id', RUN_ID);
  });

  it('calibration có đủ khoá loader bắt buộc (REPORT_P0 (d))', () => {
    const calibration = JSON.parse(fileOf(bundle().files, 'calibration.json')) as Record<string, unknown>;
    for (const key of [
      'schema_version',
      'calibration_status',
      'camera_transforms',
      'edge_adjacency',
      'overlap_world_polygon',
      'parking_slots_world',
      'tracking_defaults',
      'matching_defaults',
      'world',
    ]) {
      expect(calibration, `thiếu khoá ${key}`).toHaveProperty(key);
    }
    const transforms = calibration.camera_transforms as Record<string, number[][]>;
    expect(Object.keys(transforms).sort()).toEqual(['cam1', 'cam2']);
    for (const matrix of Object.values(transforms)) {
      expect(matrix).toHaveLength(3);
      for (const row of matrix) {
        expect(row).toHaveLength(3);
        for (const value of row) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
    expect(calibration.edge_adjacency).toEqual([
      { source_camera: 'cam1', exit_edge: 'right', target_camera: 'cam2' },
      { source_camera: 'cam2', exit_edge: 'left', target_camera: 'cam1' },
    ]);
    const overlap = calibration.overlap_world_polygon as number[][];
    expect(overlap.length).toBeGreaterThanOrEqual(3);
  });

  it('tracking_defaults / matching_defaults chép nguyên từ toi1 (D2/D3)', () => {
    const calibration = JSON.parse(fileOf(bundle().files, 'calibration.json')) as {
      tracking_defaults: unknown;
      matching_defaults: unknown;
    };
    expect(calibration.tracking_defaults).toEqual(SAMPLE_TRACKING_DEFAULTS);
    expect(calibration.matching_defaults).toEqual(SAMPLE_MATCHING_DEFAULTS);
    expect(SAMPLE_MATCHING_DEFAULTS.handoff_match_distance).toBe(15.0);
    expect(SAMPLE_MATCHING_DEFAULTS.cross_camera_duplicate_distance).toBe(9.0);
  });

  it('masks đúng cỡ ảnh đã phóng và nằm trong khung (BRIEF_P15)', () => {
    const { files } = bundle();
    // Mặc định `s = 2` ⇒ 800×1280. Test cũ khẳng định 400×640; nay phải theo hệ số.
    const size = techgarImageSize(TECHGAR_SCALE);
    for (const name of ['roi_mask_cam1.json', 'roi_mask_cam2.json']) {
      const mask = JSON.parse(fileOf(files, name)) as {
        polygon: { x: number; y: number }[];
        image_size: [number, number];
      };
      expect(mask.image_size).toEqual([size.width, size.height]);
      expect(mask.polygon.length).toBeGreaterThanOrEqual(3);
      for (const point of mask.polygon) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(size.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(size.height);
      }
    }
  });

  it('mask bao toàn mặt bãi: phủ làn A2 và rộng hơn khung bao ô (BRIEF_P15 mục B)', () => {
    const { files } = bundle();
    const size = techgarImageSize(TECHGAR_SCALE);
    for (const name of ['roi_mask_cam1.json', 'roi_mask_cam2.json']) {
      const mask = JSON.parse(fileOf(files, name)) as {
        polygon: { x: number; y: number }[];
        image_size: [number, number];
      };
      const xs = mask.polygon.map((point) => point.x);
      const ys = mask.polygon.map((point) => point.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      // 1) Phủ hết bề ngang khung cam. Mask cũ (khung bao ô) chỉ x 16,09..392,94 trên 400 —
      // đoạn đường xe chạy qua mép ảnh (làn cổng, u ≈ 0 và 400) bị cắt mất.
      expect(minX).toBe(0);
      expect(maxX).toBe(size.width);

      // 2) Phủ làn chạy giữa bãi (A2 ở v = 343 trên khung 640).
      const laneY = 343 * TECHGAR_SCALE;
      expect(minY).toBeLessThan(laneY);
      expect(maxY).toBeGreaterThan(laneY);

      // 3) Phủ làn A3 ở v = 528 trên khung 640. Khung bao ô cũ dừng ở 505,78 nên làn cuối bãi
      // nằm ngoài mask — đây là phần BRIEF_P15 mục B yêu cầu thêm.
      expect(maxY).toBeGreaterThan(528 * TECHGAR_SCALE);

      // 4) Vẫn phủ mép trên của ô đầu tiên (v ≈ 146,67).
      expect(minY).toBeLessThanOrEqual(146.67 * TECHGAR_SCALE);
      expect(mask.image_size).toEqual([size.width, size.height]);
    }
  });

  it('mask rỗng (không ô nào thuộc cam) thì ném lỗi, không xuất mask giả', () => {
    expect(() => buildRoiMask(LOT, [0, 1], 0)).toThrow(/không ô nào thuộc khung cam/);
  });

  it('gate_zones đúng schema và có direction hợp lệ', () => {
    const origin = lotCenter(LOT);
    const k = computeK(LOT);
    const gates = buildGateZones(LOT, origin, k);
    expect(gates.schema_version).toBe(1);
    expect(gates.coordinate_space).toBe('world');
    expect(gates.unit).toBe('cm');
    expect(gates.source).toBe('sim3d');
    for (const key of ['entry_gate', 'exit_gate'] as const) {
      expect(['positive', 'negative']).toContain(gates[key].direction);
      expect(Number.isFinite(gates[key].p1.x)).toBe(true);
      expect(Number.isFinite(gates[key].p2.y)).toBe(true);
    }
  });

  it('gate direction khớp công thức cross product của TechGAR', () => {
    const origin = lotCenter(LOT);
    const k = computeK(LOT);
    const gates = buildGateZones(LOT, origin, k);
    // Kiểm lại theo đúng công thức gate_session_controller.py:242-256.
    const travelIn = [
      LOT.gates.in.despawn[0] - LOT.gates.in.spawn[0],
      LOT.gates.in.despawn[1] - LOT.gates.in.spawn[1],
    ];
    const gx = gates.entry_gate.p2.x - gates.entry_gate.p1.x;
    const gy = gates.entry_gate.p2.y - gates.entry_gate.p1.y;
    // Đổi hướng đi sang world unit (chỉ đổi tỉ lệ, dấu giữ nguyên).
    const cross = travelIn[0] * gy - travelIn[1] * gx;
    expect(gates.entry_gate.direction).toBe(cross > 0 ? 'positive' : 'negative');
  });

  it('MANIFEST ghi k cụ thể + số liệu kiểm chéo (D2, G0 A.3)', () => {
    const { files } = bundle();
    const manifest = JSON.parse(fileOf(files, 'MANIFEST.json')) as {
      source: string;
      world_unit: string;
      world_scale_k: number;
      depth_check: Record<string, number>;
      image_size: number[];
      image_scale: number;
      run_id: string;
      scenario_hash: string;
    };
    expect(manifest.source).toBe('sim3d');
    expect(manifest.world_unit).toBe('cm');
    expect(manifest.world_scale_k).toBeGreaterThan(1.5);
    // BRIEF_P15: MANIFEST ghi image_size đã phóng **và** hệ số s.
    expect(manifest.image_scale).toBe(TECHGAR_SCALE);
    const size = techgarImageSize(TECHGAR_SCALE);
    expect(manifest.image_size).toEqual([size.width, size.height]);
    expect(manifest.run_id).toBe(RUN_ID);
    expect(manifest.scenario_hash).toBe(SCENARIO_HASH);
    expect(Number(manifest.depth_check.sample_short_median)).toBe(SAMPLE_SLOT_SHORT_MEDIAN);
    expect(Number(manifest.depth_check.sample_long_median)).toBe(SAMPLE_SLOT_LONG_MEDIAN);
    expect(Number(manifest.depth_check.tolerance)).toBe(DEPTH_CHECK_TOLERANCE);
    expect(Number(manifest.depth_check.relative_error)).toBeLessThanOrEqual(DEPTH_CHECK_TOLERANCE);
  });

  it('MANIFEST liệt kê đủ 7 file kèm README (BE verify mục 4)', () => {
    const manifest = JSON.parse(fileOf(bundle().files, 'MANIFEST.json')) as {
      files: Record<string, string>;
    };
    expect(Object.values(manifest.files).sort()).toEqual([
      'README.txt',
      'calibration.json',
      'gate_zones.json',
      'parking_slots_cam1.json',
      'parking_slots_cam2.json',
      'roi_mask_cam1.json',
      'roi_mask_cam2.json',
    ]);
  });

  it('README có lệnh đầy đủ + --replay-session + --gate-config + kết luận gate', () => {
    const readme = fileOf(bundle().files, 'README.txt');
    expect(readme).toContain('gate_session_controller.py');
    expect(readme).toContain('--gate-config');
    expect(readme).toContain('--live-mode');
    expect(readme).toContain('--calibration');
    expect(readme).toContain('--slots-cam1');
    expect(readme).toContain('--slots-cam2');
    expect(readme).toContain('--mask-cam1');
    expect(readme).toContain('--mask-cam2');
    expect(readme).toContain('--detector-profile');
    expect(readme).toContain('runtime_server.py');
    // P7e: cờ replay thật là `--replay-session <RUN_DIR>`, **không** phải --cam1-video.
    expect(readme).toContain('--replay-session');
    // Chỉ kiểm **trong khối lệnh** (văn xuôi được phép nhắc cờ sai để giải thích).
    const commandBlocks = readme
      .split('```powershell')
      .slice(1)
      .map((block) => block.split('```')[0] ?? '');
    expect(commandBlocks.length).toBeGreaterThan(0);
    for (const block of commandBlocks) {
      expect(block).not.toContain('--cam1-video');
      expect(block).not.toContain('--cam2-video');
    }
    expect(readme).toContain('--output-dir');
    expect(readme).toContain('--session-dir');
    expect(readme).toContain('--api-port 8001');
    expect(readme).toContain('--no-display');
    // Kết luận gate theo ANS_1 A.4.
    expect(readme).toContain('gate_session_controller');
    expect(readme).toContain('Không cần sao lưu');
    // Số liệu phải có thật.
    expect(readme).toContain('400×640');
  });

  /**
   * P10c: `gate_session_controller.py` **không có** cờ `--live-mode` (parser() dòng 855-868).
   * `--live-mode` là cờ của `runtime_server` — phải nằm ở khối lệnh Bước 1, không phải Bước 2.
   *
   * Test này canh đúng lỗi đã xảy ra: README cũ chỉ nói "chỉ cần khi chạy kèm controller" mà
   * không nói **lệnh nào**, nên người đọc gắn cờ vào controller (argparse lỗi), còn Bước 1
   * thiếu cờ thì controller đếm **0 lượt mà không báo** (`_fresh_live` bỏ qua source_mode=replay).
   */
  it('README: --live-mode thuộc khối lệnh runtime_server, KHÔNG thuộc controller', () => {
    const readme = fileOf(bundle().files, 'README.txt');
    const blocks = readme
      .split('```powershell')
      .slice(1)
      .map((block) => block.split('```')[0] ?? '');
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const runtimeBlock = blocks.find((block) => block.includes('runtime_server.py'));
    const controllerBlock = blocks.find((block) =>
      block.includes('gate_session_controller.py'),
    );
    expect(runtimeBlock).toBeDefined();
    expect(controllerBlock).toBeDefined();

    // Bước 2: controller KHÔNG được có cờ này (argparse sẽ từ chối).
    expect(controllerBlock).not.toContain('--live-mode');
    // Bước 1: phải có (nếu thiếu thì controller đếm 0 mà không báo lỗi).
    expect(runtimeBlock).toContain('--live-mode');
    // Và phải nói rõ cờ thuộc runtime, không phải controller.
    expect(readme).toContain('KHÔNG có cờ `--live-mode`');
    expect(readme).toContain('runtime_server');
  });

  it('README nêu rõ calibration không có capture_manifest', () => {
    const readme = fileOf(bundle().files, 'README.txt');
    expect(readme).toContain('capture_manifest');
    expect(readme).toContain('1280×720');
  });

  it('bundle trả k + số liệu kiểm chéo để REPORT dẫn', () => {
    const result = bundle();
    expect(result.k).toBeCloseTo(computeK(LOT), 12);
    expect(result.slotDepthM).toBeCloseTo(medianSlotDepthM(LOT), 12);
    expect(result.impliedDepthM).toBeCloseTo(SAMPLE_SLOT_LONG_MEDIAN / result.k, 12);
    expect(result.depthError).toBeLessThanOrEqual(DEPTH_CHECK_TOLERANCE);
  });

  it('buildReadme cắt cảnh báo khi quá nhiều (không để file phình)', () => {
    const text = buildReadme({
      runId: 'x',
      k: 2,
      implied: 4.6,
      depthM: 4.85,
      error: 0.05,
      onlyCam1: 10,
      onlyCam2: 10,
      both: 80,
      orphanCount: 0,
      warnings: Array.from({ length: 20 }, (_, index) => `cảnh báo ${String(index)}`),
    });
    expect(text).toContain('cảnh báo 0');
    expect(text).toContain('và 12 cảnh báo nữa');
  });

  it('ô không thuộc cam nào được ghi vào cảnh báo (không im lặng)', () => {
    // Dựng lot giả: thêm 1 ô nằm ngoài cả hai khung (u > 640) bên cạnh các ô thật,
    // để mask vẫn dựng được mà vẫn kiểm được cảnh báo "ô mồ côi".
    const orphan = {
      ...LOT.slots[0],
      id: 'S999' as (typeof LOT.slots)[0]['id'],
      polygon_px: [
        [700, 100],
        [720, 100],
        [720, 140],
        [700, 140],
      ] as (typeof LOT.slots)[0]['polygon_px'],
    };
    const fake: LotMap = { ...LOT, slots: [...LOT.slots, orphan] };
    const result = buildTechgarConfig({
      lot: fake,
      cameraMode: '2cam',
      runId: RUN_ID,
      scenarioHash: SCENARIO_HASH,
      generatedAt: GENERATED_AT,
    });
    expect(result).not.toBeNull();
    const manifest = JSON.parse(fileOf(result!.files, 'MANIFEST.json')) as { warnings: string[] };
    expect(manifest.warnings.join(' ')).toContain('S999');
  });
});

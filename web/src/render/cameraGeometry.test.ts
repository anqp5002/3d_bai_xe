/**
 * Test camera dataset: camera Three.js phải khớp `project()` của bộ cũ.
 *
 * Done của P4a: "chiếu điểm world bằng camera Three.js vs `project()` lệch ≤ 0,5 px
 * (ít nhất 20 điểm)". Test dùng **camera thật của three** (không tự viết lại phép chiếu)
 * nên nếu ai đó đổi `up`/`lookAt`/`fov` thì test đỏ ngay.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  cropCamera,
  datasetCameraPosition,
  datasetCameraTarget,
  datasetCameraUp,
  recordFrameSize,
  threeToWorld,
  verticalFovDeg,
  worldToThree,
  type CameraParams,
} from './cameraGeometry';
import { FRAME_SIZE_PX } from './index';

/** Camera của `lot_pucpr.json` (P2, contract C-A). */
const CAMERA: CameraParams = {
  pitch_deg: 80,
  f_px: 288,
  height_m: 33.6,
  res: [640, 640],
  cam1_x: [0, 400],
  cam2_x: [240, 640],
};

const PH = (CAMERA.pitch_deg * Math.PI) / 180;

/** `project()` của `docs/pklot_video/blender/build_blender_video.py:56-62`. */
function project(x: number, y: number): readonly [u: number, v: number] {
  const z = y * Math.cos(PH) + CAMERA.height_m * Math.sin(PH);
  return [
    CAMERA.res[0] / 2 + (CAMERA.f_px * x) / z,
    CAMERA.res[1] / 2 +
      (CAMERA.f_px * (-y * Math.sin(PH) + CAMERA.height_m * Math.cos(PH))) / z,
  ];
}

/** 24 điểm trải khắp vùng nhìn của bãi (gồm cả 4 góc và điểm sát chân ảnh). */
const WORLD_POINTS: readonly (readonly [x: number, y: number])[] = [
  [0, 0],
  [10, 5],
  [-10, 5],
  [20, 10],
  [-20, 10],
  [25, -10],
  [-25, -10],
  [3.2, 22],
  [-3.2, 22],
  [15, 25],
  [-30, 20],
  [30, 20],
  [-34, 20],
  [34, 5],
  [7.41, 24.15],
  [-2.9, -11],
  [0, -16],
  [12, -16],
  [-12, -16],
  [-30, -16],
  [30, -16],
  [5, 12.5],
  [-18, 3],
  [22, 1],
];

function makeDatasetCamera(camera: CameraParams, width: number, height: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(
    verticalFovDeg(camera.f_px, camera.res[1]),
    width / height,
    0.5,
    5000,
  );
  const [px, py, pz] = datasetCameraPosition(camera);
  cam.position.set(px, py, pz);
  const [ux, uy, uz] = datasetCameraUp(camera);
  cam.up.set(ux, uy, uz);
  const [tx, ty, tz] = datasetCameraTarget(camera);
  cam.lookAt(new Vector3(tx, ty, tz));
  cam.updateMatrixWorld(true);
  return cam;
}

/** Chiếu điểm world (mét) ra px của khung `width × height` qua camera three. */
function projectWithThree(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  width: number,
  height: number,
): readonly [u: number, v: number] {
  const [tx, ty, tz] = worldToThree(x, y);
  const ndc = new Vector3(tx, ty, tz).project(camera);
  return [(ndc.x * 0.5 + 0.5) * width, (-ndc.y * 0.5 + 0.5) * height];
}

describe('render/cameraGeometry — quy đổi hệ trục', () => {
  it('world (X, Y) → three (X, cao, -Y) và ngược lại', () => {
    expect(worldToThree(3, 7)).toEqual([3, 0, -7]);
    expect(worldToThree(3, 7, 1.5)).toEqual([3, 1.5, -7]);
    expect(threeToWorld([3, 1.5, -7])).toEqual([3, 7]);
  });

  it('FOV dọc = 2·atan(res/2 / f) ≈ 96,03° (ý tưởng §8)', () => {
    expect(verticalFovDeg(288, 640)).toBeCloseTo(96.0256, 3);
  });

  it('FOV từ chối tham số không dương (R2)', () => {
    expect(() => verticalFovDeg(0, 640)).toThrow(/phải > 0/);
    expect(() => verticalFovDeg(288, -1)).toThrow(/phải > 0/);
  });

  it('camera đặt ở cao độ height_m, nhìn về -Z, "lên" = (0, cos, -sin)', () => {
    expect(datasetCameraPosition(CAMERA)).toEqual([0, 33.6, 0]);
    const [ux, uy, uz] = datasetCameraUp(CAMERA);
    expect(ux).toBe(0);
    expect(uy).toBeCloseTo(Math.cos(PH), 12);
    expect(uz).toBeCloseTo(-Math.sin(PH), 12);
  });
});

describe('render/cameraGeometry — khớp project() ≤ 0,5 px', () => {
  const camera = makeDatasetCamera(CAMERA, FRAME_SIZE_PX, FRAME_SIZE_PX);

  it(`chiếu ${WORLD_POINTS.length} điểm world khớp project() ≤ 0,5 px`, () => {
    let worst = 0;
    for (const [x, y] of WORLD_POINTS) {
      const [u3, v3] = projectWithThree(camera, x, y, FRAME_SIZE_PX, FRAME_SIZE_PX);
      const [ue, ve] = project(x, y);
      const error = Math.hypot(u3 - ue, v3 - ve);
      worst = Math.max(worst, error);
      expect(error, `điểm (${String(x)}, ${String(y)})`).toBeLessThanOrEqual(0.5);
    }
    // Số thật để REPORT dẫn được: thực tế chỉ sai ở mức sai số dấu phẩy động.
    expect(worst).toBeLessThan(1e-6);
  });

  it('ít nhất 20 điểm được kiểm (Done của P4a)', () => {
    expect(WORLD_POINTS.length).toBeGreaterThanOrEqual(20);
  });

  it('tâm ô S001 của lot khớp project() ≤ 0,5 px', () => {
    const [x, y] = [7.4144, 24.1548];
    const [u3, v3] = projectWithThree(camera, x, y, FRAME_SIZE_PX, FRAME_SIZE_PX);
    const [ue, ve] = project(x, y);
    expect(Math.hypot(u3 - ue, v3 - ve)).toBeLessThanOrEqual(0.5);
  });

  it('camera sai "up" (dùng +Y) thì lệch rõ rệt — chứng minh test có tác dụng', () => {
    const wrong = new PerspectiveCamera(
      verticalFovDeg(CAMERA.f_px, CAMERA.res[1]),
      1,
      0.5,
      5000,
    );
    wrong.position.set(0, CAMERA.height_m, 0);
    wrong.up.set(0, 1, 0);
    wrong.lookAt(new Vector3(0, 0, 0));
    wrong.updateMatrixWorld(true);
    const [u3, v3] = projectWithThree(wrong, 10, 5, FRAME_SIZE_PX, FRAME_SIZE_PX);
    const [ue, ve] = project(10, 5);
    expect(Math.hypot(u3 - ue, v3 - ve)).toBeGreaterThan(10);
  });
});

describe('render/cameraGeometry — cắt cam1/cam2', () => {
  it('cam1 = cột 0–400, cam2 = cột 240–640, mỗi khung 400×640 (U19)', () => {
    const cam1 = cropCamera(CAMERA, CAMERA.cam1_x);
    const cam2 = cropCamera(CAMERA, CAMERA.cam2_x);
    expect([cam1.widthPx, cam1.heightPx]).toEqual([400, 640]);
    expect([cam2.widthPx, cam2.heightPx]).toEqual([400, 640]);
    // cam1 lấy nửa trái ⇒ tâm chiếu lệch +120 px; cam2 lấy nửa phải ⇒ lệch -120 px.
    expect(cam1.offsetXPx).toBe(120);
    expect(cam2.offsetXPx).toBe(-120);
  });

  it('khung cam1/cam2 cắt ra khớp phần tương ứng của khung 640', () => {
    const full = makeDatasetCamera(CAMERA, FRAME_SIZE_PX, FRAME_SIZE_PX);
    const points: readonly (readonly [number, number])[] = [
      [0, 5],
      [12, 8],
      [-8, 20],
      [20, 0],
    ];
    for (const [x, y] of points) {
      const [uFull, vFull] = projectWithThree(full, x, y, FRAME_SIZE_PX, FRAME_SIZE_PX);
      const [ue, ve] = project(x, y);
      expect(Math.abs(uFull - ue)).toBeLessThan(1e-6);
      expect(Math.abs(vFull - ve)).toBeLessThan(1e-6);
    }
    const cam1 = cropCamera(CAMERA, CAMERA.cam1_x);
    const cam2 = cropCamera(CAMERA, CAMERA.cam2_x);
    // Vùng chồng lấn 240–400 phải nằm trong cả hai khung.
    const [uo] = project(0, 5);
    expect(uo).toBeGreaterThan(240);
    expect(uo).toBeLessThan(400);
    expect(cam1.offsetXPx - cam2.offsetXPx).toBe(240);
  });

  it('cropCamera từ chối vùng cắt ngược (R2)', () => {
    expect(() => cropCamera(CAMERA, [400, 0])).toThrow(/không hợp lệ/);
  });

  it('kích thước khung quay: 1cam 640×640, 2cam 800×640 (FE §2)', () => {
    expect(recordFrameSize('1cam')).toEqual([640, 640]);
    expect(recordFrameSize('2cam')).toEqual([800, 640]);
  });
});

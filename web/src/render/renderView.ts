/**
 * Vòng đời WebGL: tạo renderer, đặt camera theo chế độ, render một frame (P4a mục 2).
 *
 * Tách khỏi `scene.ts` để `scene.ts` test được bằng Node (không cần WebGL), còn file này
 * chỉ chạy trong trình duyệt.
 */

import { PerspectiveCamera, Vector3, WebGLRenderer } from 'three';
import type { Object3D, Scene } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LotMap } from '../contracts/lot';
import {
  CAM2_CROP_X,
  CAMERA_FRAME_WIDTH_PX,
  FRAME_SIZE_PX,
} from './index';
import {
  datasetCameraPosition,
  datasetCameraTarget,
  datasetCameraUp,
  recordFrameSize,
  verticalFovDeg,
  type CameraCount,
  type CameraParams,
  type CameraViewMode,
} from './cameraGeometry';

/** Cấu hình một lượt render. */
export interface RendererSetup {
  readonly lot: LotMap;
  readonly mode: CameraViewMode;
  readonly count: CameraCount;
  readonly canvas?: HTMLCanvasElement;
  /** Bật khử răng cưa (ảnh kiểm nên bật; xuất video P7 nên tắt cho nhanh). */
  readonly antialias?: boolean;
}

/** Bộ renderer đã cấu hình, kèm camera theo từng chế độ. */
export interface RenderView {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls | null;
  /** Đặt lại camera theo chế độ hiện tại (gọi sau khi đổi mode/count). */
  setMode(mode: CameraViewMode, count: CameraCount): void;
  /** Render một frame và trả canvas đã vẽ. */
  render(): HTMLCanvasElement;
  /** Giải phóng tài nguyên GPU. */
  dispose(): void;
}

/**
 * Đặt camera dataset đúng `project()` (P4a mục 1).
 *
 * Dùng `up = (0, cos(pitch), -sin(pitch))` — **không** phải `+Y`; xem
 * `cameraGeometry.test.ts`.
 */
export function applyDatasetCamera(
  camera: PerspectiveCamera,
  params: CameraParams,
  width: number,
  height: number,
  offsetXPx = 0,
): void {
  camera.fov = verticalFovDeg(params.f_px, params.res[1]);
  camera.aspect = width / height;
  camera.near = 0.5;
  camera.far = 5000;
  const [px, py, pz] = datasetCameraPosition(params);
  camera.position.set(px, py, pz);
  const [ux, uy, uz] = datasetCameraUp(params);
  camera.up.set(ux, uy, uz);
  const [tx, ty, tz] = datasetCameraTarget(params);
  camera.lookAt(new Vector3(tx, ty, tz));
  // Dịch tâm chiếu cho khung cắt cam1/cam2 (giữ nguyên tiêu cự).
  if (offsetXPx !== 0) {
    camera.setViewOffset(width, height, offsetXPx, 0, width, height);
  } else {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Tạo camera Tự do (orbit) nhìn bao quát bãi. */
export function applyFreeCamera(camera: PerspectiveCamera, lot: LotMap): void {
  const xs = lot.slots.flatMap((slot) => slot.polygon.map((point) => [point[0], point[1]] as const));
  const minX = Math.min(...xs.map((point) => point[0]));
  const maxX = Math.max(...xs.map((point) => point[0]));
  const minY = Math.min(...xs.map((point) => point[1]));
  const maxY = Math.max(...xs.map((point) => point[1]));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY);

  camera.fov = 45;
  camera.aspect = 1;
  camera.near = 0.5;
  camera.far = 5000;
  // Góc nhìn 3/4 từ tây-nam lên, đủ thấy toàn bãi.
  camera.position.set(cx - span * 0.15, span * 1.15, -cy + span * 1.05);
  camera.up.set(0, 1, 0);
  camera.lookAt(new Vector3(cx, 0, -cy));
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/**
 * Dựng renderer cho một chế độ. `mode = record` dùng đúng camera dataset + kích thước
 * pixel của khung quay (FE §2: không co giãn).
 */
export function createRenderView(setup: RendererSetup, scene: Scene): RenderView {
  const { lot, mode, count, antialias = true } = setup;
  const canvas = setup.canvas ?? document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias, alpha: false });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;

  const camera = new PerspectiveCamera(45, 1, 0.5, 5000);
  let controls: OrbitControls | null = null;

  const setMode = (nextMode: CameraViewMode, nextCount: CameraCount): void => {
    if (nextMode === 'free') {
      const width = FRAME_SIZE_PX;
      const height = FRAME_SIZE_PX;
      renderer.setSize(width, height, false);
      applyFreeCamera(camera, lot);
      if (controls === null) {
        controls = new OrbitControls(camera, canvas);
        controls.enableDamping = false;
        controls.target.set(0, 0, 0);
        controls.update();
      }
    } else {
      const [width, height] = recordFrameSize(nextCount);
      renderer.setSize(width, height, false);
      applyDatasetCamera(camera, lot.camera, FRAME_SIZE_PX, FRAME_SIZE_PX, 0);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      controls?.dispose();
      controls = null;
    }
    renderer.setClearColor(0x000000, 1);
  };

  setMode(mode, count);

  return {
    renderer,
    scene,
    camera,
    get controls() {
      return controls;
    },
    setMode,
    render: () => {
      renderer.render(scene, camera);
      return canvas;
    },
    dispose: () => {
      controls?.dispose();
      renderer.dispose();
    },
  };
}

/** Chụp khung 640×640 của camera dataset, KHÔNG cắt cam (chế độ 1 cam). */
export function datasetFrameSize(): readonly [number, number] {
  return [FRAME_SIZE_PX, FRAME_SIZE_PX];
}

/** Vị trí cắt cam1/cam2 trên khung 640 (U19). */
export const CROP = {
  cam1: [0, CAMERA_FRAME_WIDTH_PX],
  cam2: [CAM2_CROP_X, CAM2_CROP_X + CAMERA_FRAME_WIDTH_PX],
} as const;

/** Gắn một object vào group theo tên (P5/P7 dùng để thêm xe). */
export function attachToGroup(root: Scene, groupName: string, child: Object3D): void {
  const group = root.getObjectByName(groupName);
  if (group === undefined) {
    throw new Error(`attachToGroup: không có group "${groupName}" trong cảnh`);
  }
  group.add(child);
}

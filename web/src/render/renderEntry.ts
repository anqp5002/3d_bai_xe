/**
 * Trang render phục vụ `tools/shot.mjs` (P4a mục 6 + P8).
 *
 * Tham số URL:
 * - `?mode=dataset|free|record` (mặc định `dataset`)
 * - `&cams=1cam|2cam` (mặc định `1cam`)
 * - `&env=E1..E8` — bật môi trường theo kịch bản, ở `t` giữa kịch bản
 * - `&env_t=<giây>` — thời điểm trong kịch bản (mặc định giữa)
 * - `&noise=<loại>` — bật một loại nhiễu (`shake`, `grain`, …) ở mức `&noise_level=`
 * - `&noise_level=0..1` (mặc định 1)
 * - `&frame=<n>` — số frame dùng làm seed nhiễu (mặc định 0)
 * - `&crop=full|cam1|cam2` — cắt khung sau khi áp nhiễu (kiểm "áp trước khi cắt")
 *
 * Trang đặt `window.__SIM3D_READY__` khi xong; lỗi thì `window.__SIM3D_ERROR__` + banner
 * đỏ, không bao giờ treo im lặng (R2).
 */

import { Group } from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LotMap } from '../contracts/lot';
import type { CarModel } from '../contracts/sim';
import { createNoiseConfig, type NoiseConfig, type NoiseKind } from '../contracts/env';
import { api } from '../api/client';
import { buildScene } from './scene';
import { carModelUrl, carTransform, paintCar } from './carModel';
import { placeParkedCars } from './placement';
import { createRenderView, type RenderView } from './renderView';
import type { CameraCount, CameraViewMode } from './cameraGeometry';
import {
  applyEnvAtTime,
  attachLampPointLights,
  collectLampsFromScene,
  createEnvLayers,
  type EnvApplyResult,
  type EnvLayers,
} from './env/applyEnv';
import { envPreset } from './env/presets';
import { applyNoise, hashFrame, type NoiseResult, type RgbaFrame } from './noise/cameraNoise';

declare global {
  interface Window {
    __SIM3D_READY__?: boolean;
    __SIM3D_ERROR__?: string;
    /** Cho script chụp ảnh/kịch bản gọi lại. */
    __SIM3D__?: {
      ready: true;
      view: RenderView;
      lot: LotMap;
      carCount: number;
      env: EnvApplyResult | null;
      noiseHash: string | null;
      layers: EnvLayers | null;
    };
  }
}

/** Số xe đỗ sẵn mặc định của ảnh kiểm (đủ để thấy nhiều màu + nhiều ô). */
const DEFAULT_PARKED = 30;
const DEFAULT_SEED = 8811;
const CAR_SCALE = 1.1;

/** Tham số đọc từ URL. */
interface PageParams {
  readonly mode: CameraViewMode;
  readonly count: CameraCount;
  readonly env: string | null;
  readonly envT: number | null;
  readonly noise: NoiseKind | null;
  readonly noiseLevel: number;
  readonly frame: number;
  readonly crop: 'full' | 'cam1' | 'cam2';
}

function readParams(search: string): PageParams {
  const params = new URLSearchParams(search);
  const mode = params.get('mode');
  const count = params.get('cams');
  const resolvedMode: CameraViewMode =
    mode === 'free' || mode === 'record' ? mode : 'dataset';
  const resolvedCount: CameraCount = count === '2cam' ? '2cam' : '1cam';

  const envRaw = params.get('env');
  const env = envRaw === null ? null : envRaw.toUpperCase();
  if (env !== null) {
    // Ném sớm nếu mã lạ: không im lặng bỏ qua tham số người dùng đã truyền.
    envPreset(env);
  }

  const envTRaw = params.get('env_t');
  const envT = envTRaw === null ? null : Number(envTRaw);
  if (envT !== null && !Number.isFinite(envT)) {
    throw new Error(`env_t phải là số, nhận "${String(envTRaw)}"`);
  }

  const noiseRaw = params.get('noise');
  const noise = noiseRaw === null ? null : (noiseRaw as NoiseKind);

  const levelRaw = params.get('noise_level');
  const noiseLevel = levelRaw === null ? 1 : Number(levelRaw);
  if (!Number.isFinite(noiseLevel) || noiseLevel < 0 || noiseLevel > 1) {
    throw new Error(`noise_level phải trong [0,1], nhận "${String(levelRaw)}"`);
  }

  const frameRaw = params.get('frame');
  const frame = frameRaw === null ? 0 : Number(frameRaw);
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`frame phải là số nguyên >= 0, nhận "${String(frameRaw)}"`);
  }

  const cropRaw = params.get('crop');
  const crop = cropRaw === 'cam1' || cropRaw === 'cam2' ? cropRaw : 'full';

  return { mode: resolvedMode, count: resolvedCount, env, envT, noise, noiseLevel, frame, crop };
}

function findGroup(scene: Object3D, name: string): Group {
  const found: unknown = scene.getObjectByName(name);
  if (!(found instanceof Group)) {
    throw new Error(`Không tìm thấy group "${name}" trong cảnh`);
  }
  const group: Group = found as Group;
  return group;
}

/** Nạp 3 GLB một lần, rồi clone cho từng xe (clone chia sẻ geometry, nhân bản material). */
async function loadCarModels(): Promise<ReadonlyMap<CarModel, Object3D>> {
  const loader = new GLTFLoader();
  const models = new Map<CarModel, Object3D>();
  for (const model of ['sedan', 'suv', 'hatch'] as const) {
    const gltf = await loader.loadAsync(carModelUrl(model));
    models.set(model, gltf.scene);
  }
  return models;
}

/**
 * Canvas 2D phụ để đọc/ghi pixel.
 *
 * **Không** lấy `getContext('2d')` trên canvas WebGL (trình duyệt không cho một canvas
 * giữ hai loại context). Vẽ canvas WebGL sang canvas 2D này rồi đọc/ghi trên đó.
 */
function ensurePixelCanvas(width: number, height: number): HTMLCanvasElement {
  const existing: unknown = document.getElementById('sim3d-pixels');
  let pixelCanvas: HTMLCanvasElement;
  if (existing instanceof HTMLCanvasElement) {
    pixelCanvas = existing;
  } else {
    pixelCanvas = document.createElement('canvas');
    pixelCanvas.id = 'sim3d-pixels';
    pixelCanvas.style.display = 'none';
    document.body.appendChild(pixelCanvas);
  }
  if (pixelCanvas.width !== width || pixelCanvas.height !== height) {
    pixelCanvas.width = width;
    pixelCanvas.height = height;
  }
  return pixelCanvas;
}

/** Đọc pixel từ canvas WebGL (vẽ sang canvas 2D phụ trước). */
function readCanvasFrame(source: HTMLCanvasElement): RgbaFrame {
  const target = ensurePixelCanvas(source.width, source.height);
  const context = target.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('Không lấy được 2D context để đọc pixel');
  }
  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, target.width, target.height);
  return {
    width: target.width,
    height: target.height,
    data: new Uint8ClampedArray(image.data),
  };
}

/** Ghi khung RGBA trở lại canvas WebGL (qua canvas 2D, rồi blit lên canvas WebGL). */
function writeCanvasFrame(target: HTMLCanvasElement, frame: RgbaFrame): void {
  const pixelCanvas = ensurePixelCanvas(frame.width, frame.height);
  const context = pixelCanvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('Không lấy được 2D context để ghi pixel');
  }
  const image = context.createImageData(frame.width, frame.height);
  image.data.set(frame.data);
  context.putImageData(image, 0, 0);

  // Đổi kích thước canvas WebGL rồi vẽ đè ảnh 2D lên (giữ đúng pixel sau khi áp nhiễu).
  target.width = frame.width;
  target.height = frame.height;
  const webglContext = target.getContext('webgl2') ?? target.getContext('webgl');
  if (webglContext === null) {
    throw new Error('Canvas WebGL mất context khi ghi đè nhiễu');
  }
  // `preserveDrawingBuffer: false` nên phải vẽ bằng 2D qua một canvas trung gian:
  // trình duyệt không cho trộn 2D vào canvas WebGL, nên dùng `drawImage` từ 2D canvas
  // vào một canvas khác rồi thay thế node hiển thị.
  const shown = document.getElementById('sim3d-noise');
  const output = shown instanceof HTMLCanvasElement ? shown : document.createElement('canvas');
  output.id = 'sim3d-noise';
  output.width = frame.width;
  output.height = frame.height;
  const outputContext = output.getContext('2d');
  if (outputContext === null) {
    throw new Error('Không lấy được 2D context cho canvas hiển thị nhiễu');
  }
  outputContext.putImageData(image, 0, 0);
  if (shown === null) {
    target.style.display = 'none';
    document.body.appendChild(output);
  }
}

/** Cắt một cột của khung (dùng cho `crop=cam1|cam2`). */
function cropFrame(frame: RgbaFrame, u0: number, u1: number): RgbaFrame {
  const width = u1 - u0;
  const out: RgbaFrame = {
    width,
    height: frame.height,
    data: new Uint8ClampedArray(width * frame.height * 4),
  };
  for (let y = 0; y < frame.height; y += 1) {
    const srcStart = (y * frame.width + u0) * 4;
    const srcEnd = srcStart + width * 4;
    out.data.set(frame.data.subarray(srcStart, srcEnd), y * width * 4);
  }
  return out;
}

/** Vị trí mặt trời trên khung 640 (cho `flare`) — tâm ảnh nếu ban ngày. */
function sunScreenPosition(result: EnvApplyResult | null): { u: number; v: number; intensity: number } | null {
  if (result === null || result.sun.belowHorizon || result.darkness > 0.9) {
    return null;
  }
  // Mặt trời ở bắc (phương vị ~90° lúc 12h) chiếu vào phía trên ảnh; đủ để `flare` có tác dụng.
  const u = 320 + (result.sun.azimuthDeg - 90) * 2.0;
  const v = 200 - result.sun.elevationDeg * 1.2;
  return { u, v, intensity: Math.min(1, result.sun.intensity) };
}

async function main(): Promise<void> {
  const params = readParams(window.location.search);
  const lot = await api.lot();
  const built = buildScene(lot, {
    showGrid: params.mode === 'free',
    showMarkings: true,
  });

  // Canvas phải nằm trong DOM thì Playwright mới chụp được; `renderView` không tự gắn.
  const canvas = document.createElement('canvas');
  canvas.id = 'sim3d-canvas';
  document.body.appendChild(canvas);

  const view = createRenderView({ lot, mode: params.mode, count: params.count, canvas }, built.scene);

  const cars = placeParkedCars(lot.slots, DEFAULT_PARKED, DEFAULT_SEED, CAR_SCALE);
  const models = await loadCarModels();
  const carGroup = findGroup(built.scene, 'cars');

  for (const car of cars) {
    const template = models.get(car.model);
    if (template === undefined) {
      throw new Error(`Không có model GLB cho "${car.model}"`);
    }
    const root = template.clone(true);
    root.name = car.car_id;
    root.scale.setScalar(car.scale);
    const transform = carTransform(car.center[0], car.center[1], car.heading);
    root.position.set(...transform.position);
    root.rotation.y = transform.rotationY;
    root.traverse((child) => {
      child.castShadow = true;
      child.receiveShadow = true;
    });
    paintCar(root, car.color);
    carGroup.add(root);
  }

  // --- Môi trường (E1–E8) ---
  let envResult: EnvApplyResult | null = null;
  let layers: EnvLayers | null = null;
  if (params.env !== null) {
    const preset = envPreset(params.env);
    layers = createEnvLayers(built.scene, params.frame + 1);
    const lampCount = collectLampsFromScene(layers, built.scene);
    if (lampCount === 0) {
      throw new Error('Không tìm thấy đầu đèn nào trong cảnh (kiểm buildLamps)');
    }
    // Ban đêm cần chiếu sáng mặt đất, không chỉ emissive đầu đèn (FE §6).
    const lightCount = attachLampPointLights(
      layers,
      built.scene,
      lot.decor.lamps.map((lamp) => {
        // Toạ độ three: x = X, y = cao, z = -Y (xem cameraGeometry).
        return [lamp.pos[0], lamp.height_m + 0.2, -lamp.pos[1]] as const;
      }),
    );
    if (lightCount === 0) {
      throw new Error('Không gắn được point light nào cho đèn bãi');
    }
    const t = params.envT === null ? preset.duration_s / 2 : params.envT;
    envResult = applyEnvAtTime({ scene: built.scene, lights: built.lights, layers }, preset.keyframes, t);
  }

  // Render một lần rồi mới báo sẵn sàng — tránh Playwright chụp khung trắng.
  view.render();

  // --- Nhiễu camera: áp TRƯỚC khi cắt cam (FE §6) ---
  let noiseHash: string | null = null;
  if (params.noise !== null) {
    const config: NoiseConfig = {
      ...createNoiseConfig(DEFAULT_SEED),
      [params.noise]: { on: true, level: params.noiseLevel },
    };
    const full = readCanvasFrame(canvas);
    const result: NoiseResult = applyNoise(full, config, {
      frame: params.frame,
      raining: envResult !== null && envResult.rainIntensity > 0,
      sun: sunScreenPosition(envResult),
    });
    noiseHash = hashFrame(result.frame);

    // Cắt SAU khi áp nhiễu (đúng FE §6: vùng chồng lấn của hai cam giống hệt nhau).
    const cropped =
      params.crop === 'cam1'
        ? cropFrame(result.frame, 0, 400)
        : params.crop === 'cam2'
          ? cropFrame(result.frame, 240, 640)
          : result.frame;
    // Ghi ra canvas hiển thị đúng khung đã cắt để ảnh chụp đúng kích thước.
    writeCanvasFrame(canvas, cropped);
  }

  window.__SIM3D__ = {
    ready: true,
    view,
    lot,
    carCount: cars.length,
    env: envResult,
    noiseHash,
    layers,
  };
  window.__SIM3D_READY__ = true;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  window.__SIM3D_ERROR__ = message;
  // R2: lỗi phải hiện ra, không im lặng.
  const banner = document.createElement('pre');
  banner.style.cssText = 'color:#f66;background:#200;padding:12px;font:12px monospace';
  banner.textContent = `LỖI RENDER: ${message}`;
  document.body.appendChild(banner);
  console.error(error);
});

/**
 * Áp môi trường lên cảnh Three.js (FE §6): mặt trời, mây, mưa, sương, đêm, đèn.
 *
 * Tách khỏi `scene.ts` để `scene.ts` chỉ dựng hình khối, còn phần "trời" ở đây thay được
 * theo thời gian mà không dựng lại cảnh.
 *
 * **Chỉ import three, không import DOM/WebGL** ⇒ test được bằng Node với cảnh thật
 * (three không cần WebGL để dựng `Scene`/`Mesh`/`Light`).
 */

import {
  AdditiveBlending,
  BufferAttribute,
  DataTexture,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  FogExp2,
  LinearFilter,
  RGBAFormat,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type DirectionalLight,
  type HemisphereLight,
  type AmbientLight,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import type { EnvKeyframe } from '../../contracts/env';
import { interpolateEnv } from '../../contracts/env';
import { darknessAt, sunState, type SunState } from './sun';
import { SCENE_COLORS } from '../palette';

/** Tham số áp môi trường. */
export interface EnvApplyOptions {
  readonly scene: Scene;
  readonly lights: {
    readonly hemisphere: HemisphereLight;
    readonly sun: DirectionalLight;
    readonly ambient: AmbientLight;
  };
  /** Group chứa các vật thể môi trường (mây, mưa, đèn) — tạo sẵn bởi `createEnvLayers`. */
  readonly layers: EnvLayers;
  /** Mốc môi trường đã nội suy (hoặc cả danh sách + `t_s`). */
  readonly env: EnvKeyframe;
}

/** Kết quả một lần áp môi trường (để UI/log đọc). */
export interface EnvApplyResult {
  readonly sun: SunState;
  readonly darkness: number;
  readonly lampsOn: boolean;
  readonly rainIntensity: number;
  readonly wetness: number;
  readonly fogDensity: number;
  readonly cloudCover: number;
}

/** Các group + vật thể môi trường, tạo một lần cho mỗi cảnh. */
export interface EnvLayers {
  readonly root: Group;
  readonly clouds: Group;
  readonly rain: LineSegments;
  readonly rainMaterial: LineBasicMaterial;
  readonly sky: Mesh;
  /** Texture gradient troi (gan vao `scene.background`). */
  readonly skyTexture: DataTexture;
  readonly lampLights: readonly Mesh[];
  readonly lampGlows: readonly Mesh[];
  /** Point light thật dưới mỗi cột đèn — chiếu sáng mặt đất ban đêm (FE §6). */
  readonly lampPointLights: readonly PointLight[];
  /** Đường ướt (dải phản chiếu trên nhựa) — bật/tắt theo `wet`. */
  readonly wetSheen: Mesh;
  readonly wetMaterial: MeshBasicMaterial;
}

/** Số hạt mưa tối đa (đủ dày ở 640×640, vẫn nhanh). */
export const RAIN_COUNT = 1800;
/** Bán kính vùng mưa quanh tâm bãi (m). */
export const RAIN_RADIUS_M = 45;
/** Chiều cao vùng mưa (m). */
export const RAIN_HEIGHT_M = 30;

/** Số cụm mây. */
export const CLOUD_COUNT = 14;

/** RNG tất định cho môi trường (không dùng `Math.random` — R3 tinh thần, dù file này không ở `sim/`). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** So buoc gradient troi (pixel doc) - du muot, rat nhe. */
export const SKY_GRADIENT_STEPS = 64;

/**
 * Tao texture gradient troi doc (1 x N) - dung lam `scene.background`.
 *
 * Dung `DataTexture` thay vi `CanvasTexture` de khong can DOM (test chay Node duoc) va de
 * mau hoan toan tat dinh. Gradient: tren = `top`, giua = `horizon`, duoi = `ground`.
 */
export function createSkyGradient(top: string, horizon: string, ground: string): DataTexture {
  const data = new Uint8Array(SKY_GRADIENT_STEPS * 4);
  const topColor = new Color(top);
  const horizonColor = new Color(horizon);
  const groundColor = new Color(ground);
  for (let index = 0; index < SKY_GRADIENT_STEPS; index += 1) {
    // `DataTexture` có `flipY = false` nên hàng 0 nằm ở **đáy** ảnh (three dùng UV gốc
    // dưới-trái). Vì vậy `t = 0` phải là màu mặt đất, `t = 1` là màu trời trên.
    const t = 1 - index / (SKY_GRADIENT_STEPS - 1);
    const low = t < 0.62 ? topColor : horizonColor;
    const high = t < 0.62 ? horizonColor : groundColor;
    const local = t < 0.62 ? t / 0.62 : (t - 0.62) / 0.38;
    const rgb = [
      low.r + (high.r - low.r) * local,
      low.g + (high.g - low.g) * local,
      low.b + (high.b - low.b) * local,
    ];
    const offset = index * 4;
    data[offset] = Math.round(rgb[0] * 255);
    data[offset + 1] = Math.round(rgb[1] * 255);
    data[offset + 2] = Math.round(rgb[2] * 255);
    data[offset + 3] = 255;
  }
  const texture = new DataTexture(data, 1, SKY_GRADIENT_STEPS, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createEnvLayers(scene: Scene, seed = 1): EnvLayers {
  const root = new Group();
  root.name = 'env';
  scene.add(root);

  // Trời: gradient dọc làm `scene.background` (không dùng cầu shader — camera dataset chúi
  // 80° nên hướng nhìn gần như thẳng xuống, cầu shader luôn ra màu "dưới chân trời").
  const initial = skyColorsFor(0);
  const skyTexture = createSkyGradient(initial.top, initial.horizon, initial.ground);
  scene.background = skyTexture;
  // Giữ một mesh rỗng tên `env-sky` để lớp khác/test tìm theo tên như trước.
  const sky = new Mesh(new BufferGeometry());
  sky.name = 'env-sky';
  sky.visible = false;
  root.add(sky);

  // Mây: các cụm cầu dẹt, nửa trong suốt, đặt cao.
  const clouds = new Group();
  clouds.name = 'env-clouds';
  const cloudMaterial = new MeshStandardMaterial({
    color: new Color('#f2f4f6'),
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  const random = mulberry32(seed ^ 0x5eed);
  for (let index = 0; index < CLOUD_COUNT; index += 1) {
    const cluster = new Group();
    const puffs = 3 + Math.floor(random() * 3);
    for (let puff = 0; puff < puffs; puff += 1) {
      const radius = 9 + random() * 12;
      const geometry = new SphereGeometry(radius, 8, 6);
      const mesh = new Mesh(geometry, cloudMaterial);
      mesh.position.set((random() - 0.5) * 26, (random() - 0.5) * 4, (random() - 0.5) * 20);
      mesh.scale.y = 0.42;
      cluster.add(mesh);
    }
    cluster.position.set((random() - 0.5) * 260, 95 + random() * 35, (random() - 0.5) * 260);
    clouds.add(cluster);
  }
  clouds.visible = false;
  root.add(clouds);

  // Mưa: Points với vị trí sinh tất định (seed), rơi bằng cách dịch `position.y` theo thời gian.
  const rainPositions = new Float32Array(RAIN_COUNT * 3);
  for (let index = 0; index < RAIN_COUNT; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * RAIN_RADIUS_M;
    rainPositions[index * 3] = Math.cos(angle) * radius;
    rainPositions[index * 3 + 1] = random() * RAIN_HEIGHT_M;
    rainPositions[index * 3 + 2] = Math.sin(angle) * radius;
  }
  // Mua ve thanh **vet** (LineSegments), khong dung Points: o 640x640 hat Points la o
  // vuong dac trong nhu tuyet. Moi vet dai 0,8 m theo huong roi.
  const streakPositions = new Float32Array(RAIN_COUNT * 6);
  for (let index = 0; index < RAIN_COUNT; index += 1) {
    const x = rainPositions[index * 3];
    const y = rainPositions[index * 3 + 1];
    const z = rainPositions[index * 3 + 2];
    const offset = index * 6;
    streakPositions[offset] = x;
    streakPositions[offset + 1] = y;
    streakPositions[offset + 2] = z;
    streakPositions[offset + 3] = x + 0.03;
    streakPositions[offset + 4] = y - 0.85;
    streakPositions[offset + 5] = z;
  }
  const rainGeometry = new BufferGeometry();
  rainGeometry.setAttribute('position', new BufferAttribute(streakPositions, 3));
  const rainMaterial = new LineBasicMaterial({
    color: new Color('#cfd8e3'),
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const rain = new LineSegments(rainGeometry, rainMaterial);
  rain.name = 'env-rain';
  rain.visible = false;
  root.add(rain);

  // Đường ướt: mặt phẳng sát mặt đất, phản chiếu mờ, bật theo `wet`.
  const wetMaterial = new MeshBasicMaterial({
    color: new Color('#8fa3b8'),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const wetSheen = new Mesh(new PlaneGeometry(120, 100, 1, 1), wetMaterial);
  wetSheen.name = 'env-wet';
  wetSheen.rotation.x = -Math.PI / 2;
  wetSheen.position.set(0, 0.02, 0);
  wetSheen.visible = false;
  root.add(wetSheen);

  return {
    root,
    clouds,
    rain,
    rainMaterial,
    sky,
    skyTexture,
    lampPointLights: [],
    lampLights: [],
    lampGlows: [],
    wetSheen,
    wetMaterial,
  };
}

/** Màu trời theo độ tối (ngày → chạng vạng → đêm). */
export function skyColorsFor(darkness: number): {
  top: string;
  horizon: string;
  ground: string;
} {
  const clamp = Math.max(0, Math.min(1, darkness));
  const mix = (day: readonly number[], night: readonly number[]): string => {
    const rgb = day.map((channel, index) =>
      Math.round(channel + (night[index] - channel) * clamp),
    );
    return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    top: mix([91, 155, 213], [10, 14, 26]),
    horizon: mix([207, 228, 242], [26, 32, 48]),
    ground: mix([109, 122, 134], [12, 16, 22]),
  };
}

/** Độ mây 0..1 từ `weather` + `intensity`. */
export function cloudCoverFor(env: EnvKeyframe): number {
  switch (env.weather) {
    case 'sun':
      return Math.max(0, Math.min(0.2, env.intensity * 0.18));
    case 'cloud':
      return 0.45 + env.intensity * 0.5;
    case 'rain':
      return 0.75 + env.intensity * 0.25;
    case 'fog':
      return 0.5 + env.intensity * 0.3;
    default: {
      const exhaustive: never = env.weather;
      throw new Error(`cloudCoverFor: weather lạ ${String(exhaustive)}`);
    }
  }
}

/** Cường độ mưa 0..1 (0 khi không mưa). */
export function rainIntensityFor(env: EnvKeyframe): number {
  return env.weather === 'rain' ? Math.max(0.15, Math.min(1, env.intensity)) : 0;
}

/** Độ ướt mặt đường 0..1 (giữ lại sau khi tạnh — E4). */
export function wetnessFor(env: EnvKeyframe): number {
  const declared = env.wet;
  if (declared !== undefined && declared > 0) {
    return Math.max(0, Math.min(1, declared));
  }
  if (env.weather === 'rain') {
    return Math.max(0.3, Math.min(1, env.intensity));
  }
  return declared === undefined ? 0 : Math.max(0, Math.min(1, declared));
}

/** Mật độ sương cho `FogExp2` — 0 là tắt hẳn. */
export function fogDensityFor(env: EnvKeyframe): number {
  const base = env.weather === 'fog' ? 0.012 * Math.max(0.2, env.intensity) : 0;
  const extra = (env.fog ?? 0) * 0.016;
  return base + extra;
}

/**
 * Áp môi trường lên cảnh và trả số liệu đã dùng (để test/REPORT dẫn).
 *
 * Hàm **thuần theo nghĩa**: cùng `env` + cùng cảnh ⇒ cùng kết quả cấu hình; không đọc
 * đồng hồ, không random (RNG chỉ dùng lúc tạo hạt mưa).
 */
export function applyEnv(options: EnvApplyOptions): EnvApplyResult {
  const { scene, lights, layers, env } = options;
  const rain = rainIntensityFor(env);
  const sun = sunState(env.hour, rain);
  const darkness = darknessAt(env.hour);
  const cloudCover = cloudCoverFor(env);
  const wetness = wetnessFor(env);
  const fogDensity = fogDensityFor(env);

  // --- Mặt trời ---
  const position = new Vector3(sun.position[0], sun.position[2], -sun.position[1]);
  lights.sun.position.copy(position);
  lights.sun.color = new Color(sun.colorHex);
  // Nắng yếu đi khi mây dày hoặc mưa; đêm thì tắt hẳn.
  const attenuation = 1 - cloudCover * 0.75 - rain * 0.25;
  lights.sun.intensity = Math.max(0, sun.intensity * Math.max(0.05, attenuation) * 2.2);
  lights.sun.castShadow = lights.sun.intensity > 0.05;

  // --- Ambient / hemisphere: đêm tối, mây giảm tương phản ---
  lights.hemisphere.intensity = 1.4 * (1 - darkness * 0.82) * (1 - cloudCover * 0.25);
  lights.ambient.intensity = 0.25 + cloudCover * 0.25 + darkness * 0.35;

  // --- Trời ---
  const colors = skyColorsFor(darkness);
  const previous = layers.skyTexture;
  const texture = createSkyGradient(colors.top, colors.horizon, colors.ground);
  (layers as { skyTexture: DataTexture }).skyTexture = texture;
  previous.dispose();
  scene.background = texture;

  // --- Sương ---
  if (fogDensity > 0.0008) {
    scene.fog = new FogExp2(new Color(colors.horizon).getHex(), fogDensity);
  } else {
    scene.fog = null;
  }

  // --- Mây ---
  layers.clouds.visible = cloudCover > 0.25;
  layers.clouds.children.forEach((cluster, index) => {
    const mesh = cluster as Group;
    // Độ mờ theo mức mây; cụm thấp hơn khi mây dày (trông nặng).
    mesh.position.y = 95 + (1 - cloudCover) * 35 + (index % 3) * 6;
  });

  // --- Mưa ---
  const rainOn = rain > 0;
  layers.rain.visible = rainOn;
  layers.rainMaterial.opacity = Math.min(0.9, 0.25 + rain * 0.7);
  layers.rainMaterial.color = new Color(darkness > 0.5 ? '#9fb4c8' : '#cfd8e3');

  // --- Đường ướt ---
  layers.wetSheen.visible = wetness > 0.05;
  layers.wetMaterial.opacity = wetness * 0.18;
  layers.wetMaterial.color = new Color(darkness > 0.5 ? '#5f7893' : '#93a8bd');

  // --- Đèn bãi ---
  const lampsOn = sun.lampsOn;
  for (const head of layers.lampLights) {
    const material = head.material;
    if (material instanceof MeshStandardMaterial) {
      material.emissiveIntensity = lampsOn ? 2.2 : 0;
      material.color = new Color(lampsOn ? '#ffe3ae' : SCENE_COLORS.lamp);
    }
  }
  for (const glow of layers.lampGlows) {
    glow.visible = lampsOn;
  }
  for (const light of layers.lampPointLights) {
    light.visible = lampsOn;
    light.intensity = lampsOn ? 90 : 0;
  }

  return {
    sun,
    darkness,
    lampsOn,
    rainIntensity: rain,
    wetness,
    fogDensity,
    cloudCover,
  };
}

/**
 * Nội suy mốc rồi áp — tiện cho vòng render mỗi frame.
 *
 * @param keyframes danh sách mốc của kịch bản (đã sắp theo `t_s`)
 * @param t_s thời điểm video
 */
export function applyEnvAtTime(
  options: Omit<EnvApplyOptions, 'env'>,
  keyframes: readonly EnvKeyframe[],
  t_s: number,
): EnvApplyResult {
  return applyEnv({ ...options, env: interpolateEnv(keyframes, t_s) });
}

/**
 * Đăng ký `lampLights`/`lampGlows` từ cảnh (gọi sau `buildScene`).
 *
 * `scene.ts` tạo đèn bãi dưới dạng mesh material `lamp`; ở đây thu lại để bật/tắt.
 */
export function registerLamps(
  layers: EnvLayers,
  heads: readonly Mesh[],
  glows: readonly Mesh[] = [],
): void {
  (layers.lampLights as Mesh[]).push(...heads);
  (layers.lampGlows as Mesh[]).push(...glows);
}

/**
 * Gan PointLight cho tung cot den: ban dem can **chieu sang mat dat**, khong chi
 * emissive dau den (neu chi emissive thi san van den - anh E6 dau tien bi nhu vay).
 *
 * Gioi han 8 den theo FE §6 ("toi da 8 point/spot light") de khong pha hieu nang.
 */
export function attachLampPointLights(
  layers: EnvLayers,
  scene: Scene,
  positions: readonly (readonly [number, number, number])[],
  maxLights = 8,
): number {
  const lights: PointLight[] = [];
  for (const [index, position] of positions.slice(0, maxLights).entries()) {
    const light = new PointLight(0xffe3ae, 0, 42, 1.6);
    light.position.set(position[0], position[1], position[2]);
    light.name = `lamp-point-${String(index)}`;
    light.visible = false;
    scene.add(light);
    lights.push(light);
  }
  (layers.lampPointLights as PointLight[]).push(...lights);
  return lights.length;
}

/**
 * Tìm các đầu đèn trong cảnh và đăng ký vào `layers`.
 *
 * `scene.ts` gắn material đèn bằng `userData.sim3d` = `'lamp'` (không đặt `name` vì
 * `MeshStandardMaterial.name` được P3 dùng cho tên material của GLB xe). Nhận cả hai cách
 * để không phụ thuộc một quy ước duy nhất. Trả số đèn tìm được.
 */
export function collectLampsFromScene(layers: EnvLayers, scene: Scene): number {
  const heads: Mesh[] = [];
  scene.traverse((object) => {
    if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) {
      return;
    }
    const material = object.material;
    const tagged = (material.userData as { sim3d?: string }).sim3d === 'lamp';
    if (tagged || material.name === 'lamp') {
      heads.push(object as Mesh);
    }
  });
  registerLamps(layers, heads);
  return heads.length;
}

/** Vầng sáng dưới đèn (mặt phẳng phát sáng) — dùng cho ban đêm có mưa (E8). */
export function createLampGlow(position: readonly [number, number, number], radius = 3.2): Mesh {
  const material = new MeshBasicMaterial({
    color: new Color('#ffe0a8'),
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(new PlaneGeometry(radius * 2, radius * 2), material);
  mesh.position.set(position[0], 0.05, position[2]);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  return mesh;
}

/** Hình nón thể tích dưới đèn (giả lập chùm sáng) — rẻ hơn `SpotLight` thật. */
export function createLampCone(
  position: readonly [number, number, number],
  height = 6,
  radius = 3.4,
): Mesh {
  const material = new MeshBasicMaterial({
    color: new Color('#ffe8c0'),
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(new ConeGeometry(radius, height, 12, 1, true), material);
  mesh.position.set(position[0], height / 2, position[2]);
  mesh.visible = false;
  return mesh;
}

/** Đường viền mưa dạng vệt (line ngắn) — dùng cho ảnh kiểm chất lượng cao. */
export function createRainStreaks(count = 600, seed = 3): LineSegments {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 6);
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * RAIN_RADIUS_M;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = random() * RAIN_HEIGHT_M;
    positions[index * 6] = x;
    positions[index * 6 + 1] = y;
    positions[index * 6 + 2] = z;
    positions[index * 6 + 3] = x + 0.05;
    positions[index * 6 + 4] = y - 0.9;
    positions[index * 6 + 5] = z;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new LineBasicMaterial({
    color: new Color('#c9d6e4'),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const lines = new LineSegments(geometry, material);
  lines.name = 'env-rain-streaks';
  lines.visible = false;
  return lines;
}

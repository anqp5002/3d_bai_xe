/**
 * Dựng cảnh Three.js từ `LotMap` (FE §6, P4a mục 5).
 *
 * Nguyên tắc: **mọi hình khối đọc từ `lot`**, không hard-code toạ độ. P2b đổi
 * `lot_pucpr.json` thì chỉ cần chạy lại, không sửa code này.
 *
 * Hệ trục: world sim `(X, Y)` mét -> three `(x = X, y = cao, z = -Y)` (xem `cameraGeometry`).
 */

import {
  AmbientLight,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  Vector2,
} from 'three';
import type { LotMap, Vec2 } from '../contracts/lot';
import { SCENE_COLORS, SCENE_ROUGHNESS, SKY_COLOR, SURFACE_LIFT } from './palette';
import { decorStalls, gateMarkings, grassOutsideAisles, roadPolygons } from './groundPlan';
import { worldToThree } from './cameraGeometry';

/** Tên group trong cảnh - test và lớp khác tìm theo tên, không theo thứ tự. */
export const SCENE_GROUPS = {
  ground: 'ground',
  slots: 'slots',
  aisles: 'aisles',
  decor: 'decor',
  cars: 'cars',
  helpers: 'helpers',
} as const;

export type SceneGroupName = (typeof SCENE_GROUPS)[keyof typeof SCENE_GROUPS];

/** Kết quả dựng cảnh: scene + các group để lớp khác thêm/bớt vật thể. */
export interface BuiltScene {
  readonly scene: Scene;
  readonly groups: Readonly<Record<SceneGroupName, Group>>;
  /** Đèn nền, để P8 đổi theo giờ/thời tiết mà không dựng lại cảnh. */
  readonly lights: {
    readonly hemisphere: HemisphereLight;
    readonly sun: DirectionalLight;
    readonly ambient: AmbientLight;
  };
}

/** Tuỳ chọn dựng cảnh. */
export interface SceneOptions {
  /** Hiện lưới ô (chế độ Tự do, FE §2). Mặc định `false` cho ảnh dataset sạch. */
  readonly showGrid?: boolean;
  /** Hiện vạch kẻ ô. Mặc định `true`. */
  readonly showMarkings?: boolean;
  /** Bật bóng đổ (FE §6: shadow map 2048, chỉ xe và cây). Mặc định `true`. */
  readonly shadows?: boolean;
}

/** Dựng đa giác phẳng (quạt tam giác) - không cần `earcut` vì mọi đa giác ở đây lồi. */
function polygonGeometry(points: readonly Vec2[], lift: number): BufferGeometry {
  if (points.length < 3) {
    throw new Error(`polygonGeometry: cần >= 3 điểm, nhận ${String(points.length)}`);
  }
  const positions: number[] = [];
  const first = points[0];
  // World (X, Y) -> three (X, 0, -Y) làm **đảo chiều** vòng đỉnh, nên phải phát tam giác
  // theo thứ tự ngược lại để pháp tuyến hướng lên +Y (nếu không mặt bị backface cull).
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    for (const point of [first, b, a]) {
      const [x, y, z] = worldToThree(point[0], point[1], lift);
      positions.push(x, y, z);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

type Materials = ReturnType<typeof makeMaterials>;

/** Vật liệu nhựa/cỏ/vạch dùng chung (tạo một lần cho cả cảnh). */
function makeMaterials() {
  const standard = (
    color: string,
    roughness: number,
    options: { side?: typeof DoubleSide; polygonOffset?: boolean } = {},
  ): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({
      color: new Color(color),
      roughness,
      metalness: 0.0,
    });
    if (options.side !== undefined) {
      material.side = options.side;
    }
    if (options.polygonOffset === true) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
    }
    return material;
  };

  return {
    asphalt: standard(SCENE_COLORS.asphalt, SCENE_ROUGHNESS.asphalt),
    laneSurface: standard(SCENE_COLORS.brick, SCENE_ROUGHNESS.brick),
    // Vạch cổng: vàng nhạt để phân biệt với vạch ô trắng (nhìn rõ trên ảnh 640).
    gateMarking: standard('#e8d24a', SCENE_ROUGHNESS.marking, { polygonOffset: true }),
    grass: standard(SCENE_COLORS.grass, SCENE_ROUGHNESS.grass),
    marking: standard(SCENE_COLORS.marking, SCENE_ROUGHNESS.marking, { polygonOffset: true }),
    curb: standard(SCENE_COLORS.curb, SCENE_ROUGHNESS.curb),
    trunk: standard(SCENE_COLORS.trunk, SCENE_ROUGHNESS.trunk),
    foliage: standard(SCENE_COLORS.foliage, SCENE_ROUGHNESS.foliage),
    pole: standard(SCENE_COLORS.pole, SCENE_ROUGHNESS.pole),
    // userData.sim3d = 'lamp': P8 tìm đầu đèn để bật emissive ban đêm. Không dùng
    // material.name vì tên đó dành cho material của GLB xe (C-C).
    lamp: Object.assign(
      new MeshStandardMaterial({
        color: new Color(SCENE_COLORS.lamp),
        emissive: new Color(SCENE_COLORS.lamp),
        emissiveIntensity: 0.0,
        roughness: 0.4,
      }),
      { userData: { sim3d: 'lamp' } },
    ),
    grid: new MeshStandardMaterial({
      color: new Color(SCENE_COLORS.grid),
      roughness: 0.9,
      side: DoubleSide,
    }),
  };
}

/** Đèn mặc định: trưa nắng (E1). P8 sẽ chỉnh theo giờ. */
function addLights(scene: Scene): BuiltScene['lights'] {
  const hemisphere = new HemisphereLight(SKY_COLOR, SCENE_COLORS.grass, 1.4);
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  const sun = new DirectionalLight(0xfff4e0, 2.1);
  // Nắng trưa hơi lệch đông-nam để xe có bóng đổ rõ như ảnh PKLot.
  sun.position.set(-40, 90, -55);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  return { hemisphere, sun, ambient };
}

/**
 * Nhựa đường: nền đường thật (`roadPolygons`) + ô **trang trí** vẽ riêng (`decorStalls`).
 *
 * Ô trang trí (11 ô, P2c nhét vào `decor.asphalt`) được đổ màu nhựa sáng hơn một chút và
 * gắn tên `decor-stall-*` để test/QA tìm được; chúng **không** nằm trong `slots` nên không
 * bao giờ có xe (task P4b mục 1–2).
 */
function buildGround(group: Group, lot: LotMap, materials: Materials): void {
  const roads = roadPolygons(lot);
  if (roads.length > 0) {
    for (const polygon of roads) {
      const mesh = new Mesh(polygonGeometry(polygon, SURFACE_LIFT.asphalt), materials.asphalt);
      mesh.receiveShadow = true;
      mesh.name = 'road';
      group.add(mesh);
    }
  } else {
    // Không có dữ liệu mặt đường: phủ theo khung bao của ô (không hard-code toạ độ).
    const xs = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[0]));
    const ys = lot.slots.flatMap((slot) => slot.polygon.map((point) => point[1]));
    const pad = 8;
    const quad: readonly Vec2[] = [
      [Math.min(...xs) - pad, Math.min(...ys) - pad],
      [Math.max(...xs) + pad, Math.min(...ys) - pad],
      [Math.max(...xs) + pad, Math.max(...ys) + pad],
      [Math.min(...xs) - pad, Math.max(...ys) + pad],
    ];
    const mesh = new Mesh(polygonGeometry(quad, SURFACE_LIFT.asphalt), materials.asphalt);
    mesh.receiveShadow = true;
    mesh.name = 'road';
    group.add(mesh);
  }

  // Ô trang trí: nền + vạch, KHÔNG xe.
  for (const [index, stall] of decorStalls(lot).entries()) {
    const mesh = new Mesh(polygonGeometry(stall.quad, SURFACE_LIFT.brick), materials.laneSurface);
    mesh.receiveShadow = true;
    mesh.name = `decor-stall-${String(index)}`;
    group.add(mesh);
  }
}

/**
 * Cỏ: **cắt khỏi lòng làn** trước khi vẽ.
 *
 * `lot_pucpr.json` (P2c) vẽ dải cỏ chạy xuyên qua 4 làn dọc; để nguyên thì cỏ nằm giữa
 * đường xe chạy (task P4b mục 4: "không còn decor cỏ giao với làn xe chạy").
 */
function buildGrass(group: Group, lot: LotMap, materials: Materials): void {
  for (const [index, polygon] of grassOutsideAisles(lot).entries()) {
    const mesh = new Mesh(polygonGeometry(polygon, SURFACE_LIFT.grass), materials.grass);
    mesh.receiveShadow = true;
    mesh.name = `grass-${String(index)}`;
    group.add(mesh);
  }
}

/** Vạch kẻ ô + vạch cổng (P4b mục 1). */
function buildMarkings(group: Group, lot: LotMap, materials: Materials): void {
  const width = 0.12;
  const addStrip = (ring: readonly Vec2[], thickness: number, material: typeof materials.marking, lift: number): void => {
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) {
        continue;
      }
      const mesh = new Mesh(new PlaneGeometry(length, thickness), material);
      const [px, py, pz] = worldToThree((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, lift);
      mesh.position.set(px, py, pz);
      // PlaneGeometry nằm trong mặt XY; xoay -90° quanh X để nằm ngang, rồi quay theo cạnh.
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(dy, dx);
      group.add(mesh);
    }
  };

  for (const slot of lot.slots) {
    addStrip(slot.polygon, width, materials.marking, SURFACE_LIFT.marking);
  }

  // Ô trang trí: chỉ vẽ vạch, KHÔNG có xe (task P4b).
  for (const stall of decorStalls(lot)) {
    addStrip(stall.quad, width * 0.85, materials.marking, SURFACE_LIFT.marking + 0.001);
  }

  // Vạch cổng: lấy `lot.gates` (nguồn sự thật) — P2c đã dời cổng, không hard-code `u`.
  for (const marking of gateMarkings(lot)) {
    const mesh = new Mesh(
      new PlaneGeometry(
        Math.hypot(
          marking.quad[1][0] - marking.quad[0][0],
          marking.quad[1][1] - marking.quad[0][1],
        ),
        0.45,
      ),
      materials.gateMarking,
    );
    const [px, py, pz] = worldToThree(
      (marking.quad[0][0] + marking.quad[1][0]) / 2,
      (marking.quad[0][1] + marking.quad[1][1]) / 2,
      SURFACE_LIFT.marking + 0.002,
    );
    mesh.position.set(px, py, pz);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(
      marking.quad[1][1] - marking.quad[0][1],
      marking.quad[1][0] - marking.quad[0][0],
    );
    mesh.name = `gate-marking-${marking.kind}`;
    group.add(mesh);
  }
}

/** Làn: dải phẳng theo `polyline` + `width_m`, kèm mũi tên chiều đi. */
function buildAisles(group: Group, lot: LotMap, materials: Materials): void {
  for (const aisle of lot.aisles) {
    const half = aisle.width_m / 2;
    const points = aisle.polyline;
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) {
        continue;
      }
      // Pháp tuyến phẳng để tạo dải rộng `width_m`. Màu nhựa sáng hơn nền một chút
      // (không dùng màu vạch: làn là mặt đường, không phải vạch kẻ).
      const nx = (-dy / length) * half;
      const ny = (dx / length) * half;
      const quad: readonly Vec2[] = [
        [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny],
      ];
      const mesh = new Mesh(polygonGeometry(quad, SURFACE_LIFT.brick), materials.laneSurface);
      mesh.receiveShadow = true;
      group.add(mesh);
      // Viền vạch hai mép làn cho rõ hình (như vạch kẻ lối đi thật).
      for (const sign of [1, -1]) {
        const edge: readonly Vec2[] = [
          [a[0] + nx * sign, a[1] + ny * sign],
          [b[0] + nx * sign, b[1] + ny * sign],
        ];
        const width = 0.1;
        const ex = edge[1][0] - edge[0][0];
        const ey = edge[1][1] - edge[0][1];
        const elen = Math.hypot(ex, ey);
        const enx = (-ey / elen) * (width / 2);
        const eny = (ex / elen) * (width / 2);
        const strip: readonly Vec2[] = [
          [edge[0][0] + enx, edge[0][1] + eny],
          [edge[1][0] + enx, edge[1][1] + eny],
          [edge[1][0] - enx, edge[1][1] - eny],
          [edge[0][0] - enx, edge[0][1] - eny],
        ];
        group.add(new Mesh(polygonGeometry(strip, SURFACE_LIFT.marking), materials.marking));
      }

      // Mũi tên chiều đi ở giữa đoạn (đồ chơi, dễ thấy từ trên cao).
      const arrow = new Shape();
      const size = Math.min(1.1, length / 3);
      arrow.moveTo(0, size);
      arrow.lineTo(-size * 0.55, -size * 0.4);
      arrow.lineTo(0, -size * 0.1);
      arrow.lineTo(size * 0.55, -size * 0.4);
      arrow.closePath();
      const arrowMesh = new Mesh(
        new ShapeGeometry(arrow),
        new MeshStandardMaterial({
          color: new Color(SCENE_COLORS.marking),
          roughness: 0.8,
          transparent: true,
          opacity: 0.8,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      const [ax, ay, az] = worldToThree(
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
        SURFACE_LIFT.marking + 0.002,
      );
      arrowMesh.position.set(ax, ay, az);
      arrowMesh.rotation.x = -Math.PI / 2;
      // Góc quay quanh Z để mũi Shape (cục bộ +Y) trỏ đúng hướng world (dx, dy).
      // Sau khi xoay -90° quanh X: +Y cục bộ thành +Z three (= -Y world), nên dấu phải
      // đảo so với góc của cạnh; kiểm bằng `aisleArrow.test.ts`.
      arrowMesh.rotation.z = -Math.atan2(dx, dy);
      group.add(arrowMesh);
    }
  }
}

/** Bó vỉa: dải hẹp nổi lên theo `decor.curbs`. */
function buildCurbs(group: Group, lot: LotMap, materials: Materials): void {
  const width = 0.25;
  const height = 0.14;
  for (const line of lot.decor.curbs) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const a = line[index];
      const b = line[index + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-6) {
        continue;
      }
      const mesh = new Mesh(boxGeometry(length, height, width), materials.curb);
      const [px, py, pz] = worldToThree(
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
        height / 2 + SURFACE_LIFT.curb,
      );
      mesh.position.set(px, py, pz);
      mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
}

/** Hộp chữ nhật đơn giản (tự dựng để không phụ thuộc thứ tự import). */
function boxGeometry(width: number, height: number, depth: number): BufferGeometry {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const corners: readonly (readonly [number, number, number])[] = [
    [-hw, -hh, -hd],
    [hw, -hh, -hd],
    [hw, hh, -hd],
    [-hw, hh, -hd],
    [-hw, -hh, hd],
    [hw, -hh, hd],
    [hw, hh, hd],
    [-hw, hh, hd],
  ];
  const faces: readonly (readonly [number, number, number, number])[] = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [1, 5, 6, 2],
    [4, 0, 3, 7],
    [3, 2, 6, 7],
    [4, 5, 1, 0],
  ];
  const positions: number[] = [];
  for (const [a, b, c, d] of faces) {
    for (const index of [a, b, c, a, c, d]) {
      positions.push(...corners[index]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Tán lá dạng cầu hơi dẹt (low-poly) - dựng từ lưới cầu để không cần file ngoài. */
function sphereishGeometry(radius: number, height: number): BufferGeometry {
  const segments = 8;
  const rings = 5;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg <= segments; seg += 1) {
      const theta = (seg / segments) * Math.PI * 2;
      const r = radius * Math.sin(phi);
      positions.push(
        r * Math.cos(theta),
        (height / 2) * Math.cos(phi) * 0.75,
        r * Math.sin(theta),
      );
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * (segments + 1) + seg;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Cây low-poly: thân trụ + tán cầu/cone. */
function buildTrees(group: Group, lot: LotMap, materials: Materials, shadows: boolean): void {
  for (const tree of lot.decor.trees) {
    const [x, , z] = worldToThree(tree.pos[0], tree.pos[1], 0);
    const trunkHeight = tree.height_m * 0.45;
    const trunk = new Mesh(
      new CylinderGeometry(tree.radius_m * 0.12, tree.radius_m * 0.16, trunkHeight, 6),
      materials.trunk,
    );
    trunk.position.set(x, trunkHeight / 2, z);
    trunk.castShadow = shadows;
    group.add(trunk);

    const canopyHeight = tree.height_m - trunkHeight;
    const canopy = new Mesh(
      tree.kind === 'cone'
        ? new ConeGeometry(tree.radius_m, canopyHeight, 8)
        : sphereishGeometry(tree.radius_m, canopyHeight),
      materials.foliage,
    );
    canopy.position.set(x, trunkHeight + canopyHeight / 2, z);
    canopy.castShadow = shadows;
    group.add(canopy);
  }
}

/** Cột đèn: trụ + đầu đèn (emissive bật khi đêm, P8 điều khiển). */
function buildLamps(group: Group, lot: LotMap, materials: Materials, shadows: boolean): void {
  for (const lamp of lot.decor.lamps) {
    const [x, , z] = worldToThree(lamp.pos[0], lamp.pos[1], 0);
    const pole = new Mesh(new CylinderGeometry(0.09, 0.12, lamp.height_m, 6), materials.pole);
    pole.position.set(x, lamp.height_m / 2, z);
    pole.castShadow = shadows;
    group.add(pole);

    const head = new Mesh(new CircleGeometry(0.35, 8), materials.lamp);
    head.position.set(x, lamp.height_m + 0.1, z);
    head.rotation.x = -Math.PI / 2;
    group.add(head);
  }
}

/** Đường viền ô dựng bằng line, chỉ hiện ở chế độ Tự do. */
function buildHelpers(group: Group, lot: LotMap, materials: Materials): void {
  for (const slot of lot.slots) {
    const ring = slot.polygon;
    const positions: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % 4];
      const [ax, ay, az] = worldToThree(a[0], a[1], 0.6);
      const [bx, by, bz] = worldToThree(b[0], b[1], 0.6);
      positions.push(ax, ay, az, bx, by, bz);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    group.add(new Mesh(geometry, materials.grid));
  }
}

/**
 * Dựng cảnh từ `lot` (FE §6, P4a mục 5).
 *
 * Chỉ đọc `lot` - không hard-code toạ độ, không đọc file. Đổi `lot_pucpr.json` (P2b)
 * thì chạy lại là xong.
 */
export function buildScene(lot: LotMap, options: SceneOptions = {}): BuiltScene {
  const { showGrid = false, showMarkings = true, shadows = true } = options;
  if (lot.slots.length === 0) {
    throw new Error('buildScene: lot không có ô nào, kiểm lại lot_pucpr.json');
  }

  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);
  // Sương rất xa để mép bãi không bị cắt cứng; P8 sẽ chỉnh theo thời tiết.
  scene.fog = new Fog(new Color(SKY_COLOR), 220, 460);

  const groups: Record<SceneGroupName, Group> = {
    ground: new Group(),
    slots: new Group(),
    aisles: new Group(),
    decor: new Group(),
    cars: new Group(),
    helpers: new Group(),
  };
  groups.ground.name = SCENE_GROUPS.ground;
  groups.slots.name = SCENE_GROUPS.slots;
  groups.aisles.name = SCENE_GROUPS.aisles;
  groups.decor.name = SCENE_GROUPS.decor;
  groups.cars.name = SCENE_GROUPS.cars;
  groups.helpers.name = SCENE_GROUPS.helpers;
  for (const group of Object.values(groups)) {
    scene.add(group);
  }

  const materials = makeMaterials();
  const lights = addLights(scene);

  buildGround(groups.ground, lot, materials);
  buildGrass(groups.ground, lot, materials);
  buildAisles(groups.aisles, lot, materials);
  if (showMarkings) {
    buildMarkings(groups.slots, lot, materials);
  }
  buildCurbs(groups.decor, lot, materials);
  buildTrees(groups.decor, lot, materials, shadows);
  buildLamps(groups.decor, lot, materials, shadows);
  if (showGrid) {
    buildHelpers(groups.helpers, lot, materials);
  } else {
    groups.helpers.visible = false;
  }

  return { scene, groups, lights };
}

/** Lặp texture nhựa (P4b dùng texture thật; ở đây chỉ giữ hằng số của FE). */
export const SURFACE_UV_REPEAT = new Vector2(24, 24);

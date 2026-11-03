/**
 * Nạp 3 model xe GLB (C-C, P4a mục 3).
 *
 * **Định hướng**: GLB xuất bằng `export_yup=True` nên trong glTF mũi xe nằm ở **-Z**
 * (Blender +Y → glTF -Z, xem `REPORT_P3.md` mục "Chưa chắc" 1). Sim dùng world
 * `(X, Y)` với hướng `heading` rad (0 = +X). Khi đặt xe:
 *
 *     mesh.position.set(x, 0, -y)      // world → three
 *     mesh.rotation.y = heading + π/2  // -Z (mũi) → +X (heading 0)
 *
 * Kiểm bằng `carModel.test.ts`: đèn trước phải ở phía +X sau khi xoay với heading=0.
 */

import { Mesh, MeshStandardMaterial, Color, Box3, Vector3 } from 'three';
import type { Group, Material, Object3D } from 'three';
import type { CarColor, CarModel } from '../contracts/sim';
import { CAR_COLOR_HEX, CAR_DIMENSIONS_M } from '../contracts/sim';
import { carPaintHex } from './palette';
import { worldToThree } from './cameraGeometry';

/** Đường dẫn model trong `public/` (C-C). */
export function carModelUrl(model: CarModel): string {
  return `/assets/cars/${model}.glb`;
}

/** Tên mesh/material bắt buộc theo C-C. */
export const CAR_MATERIALS = ['paint', 'glass', 'light_front', 'light_rear'] as const;
export type CarMaterialName = (typeof CAR_MATERIALS)[number];

/** Bánh xe là mesh riêng, tên `wheel_*` (C-C). */
export const WHEEL_PREFIX = 'wheel_';

/** Tên node bánh đúng C-C: `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr` (không tính mesh con `_1`/`_2`). */
const WHEEL_NAME = /^wheel_(fl|fr|rl|rr)$/;

/**
 * Góc xoay quanh Y để mũi xe glTF (-Z) trùng hướng `heading` của sim (0 = +X).
 *
 * `-Z` xoay +90° quanh Y thành `+X`... nhưng phép xoay dương quanh Y trong three đưa
 * `-Z` về `-X`, nên cần **-π/2 + heading**. Kiểm bằng test vector mũi xe.
 */
export function carRotationY(heading: number): number {
  return heading - Math.PI / 2;
}

/** Pose đặt xe trong hệ three. */
export interface CarTransform {
  readonly position: readonly [x: number, y: number, z: number];
  readonly rotationY: number;
}

/** Tính pose three cho một xe ở world `(x, y)` + `heading` (rad). */
export function carTransform(x: number, y: number, heading: number): CarTransform {
  return { position: worldToThree(x, y, 0), rotationY: carRotationY(heading) };
}

/** Vector mũi xe trong world sau khi xoay (dùng cho test, không phụ thuộc WebGL). */
export function noseDirection(heading: number): readonly [x: number, y: number] {
  return [Math.cos(heading), Math.sin(heading)];
}

/**
 * Vector mũi xe trong three sau khi áp `carRotationY` — phải trùng
 * `(cos(heading), 0, -sin(heading))` (tức `noseDirection` đổi sang three).
 */
export function noseDirectionInThree(heading: number): readonly [x: number, y: number, z: number] {
  const rotation = carRotationY(heading);
  // Mũi gốc của GLB là (0, 0, -1); xoay quanh Y: x' = -z·sin(r) ... áp công thức chuẩn.
  const x0 = 0;
  const z0 = -1;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [x0 * cos + z0 * sin, 0, -x0 * sin + z0 * cos];
}

/** Bản sao vật liệu đã đổi màu `paint` cho một xe (C4: 1 model × N màu). */
export function paintCar(root: Object3D, color: CarColor): void {
  const hex = carPaintHex(color);
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const raw: unknown = child.material;
    const materials: readonly Material[] = Array.isArray(raw)
      ? (raw as readonly Material[])
      : [raw as Material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) {
        continue;
      }
      if (material.name === 'paint') {
        material.color = new Color(hex);
        material.roughness = 0.32;
        material.metalness = 0.15;
        material.needsUpdate = true;
      }
    }
  });
}

/**
 * Đặt bánh xe quay theo quãng đường (P5/P7 dùng; P4a chỉ cần hàm sẵn).
 *
 * Trong GLB của P3, mỗi bánh là **một node** `wheel_fl/fr/rl/rr` bọc các mesh con
 * (`wheel_fl_1` = lốp, `wheel_fl_2` = lazăng). Xoay node bọc nên cả hai lớp quay cùng.
 * Trục quay là X của glTF (xem `REPORT_P3.md`).
 */
export function spinWheels(root: Object3D, distanceM: number, wheelRadiusM = 0.34): void {
  const angle = distanceM / wheelRadiusM;
  for (const wheel of wheelNodes(root)) {
    wheel.rotation.x = angle;
  }
}

/** Các node bánh xe (`wheel_fl`…) — khớp cả khi loader thêm hậu tố `_1`/`_2` cho mesh con. */
export function wheelNodes(root: Object3D): readonly Object3D[] {
  const nodes: Object3D[] = [];
  root.traverse((child) => {
    if (WHEEL_NAME.test(child.name)) {
      nodes.push(child);
    }
  });
  return nodes;
}

/** Các material bắt buộc có trong một model đã nạp (kiểm C-C). */
export function carMaterialNames(root: Object3D): readonly string[] {
  const names = new Set<string>();
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const raw: unknown = child.material;
    const materials: readonly Material[] = Array.isArray(raw)
      ? (raw as readonly Material[])
      : [raw as Material];
    for (const material of materials) {
      if (material.name.length > 0) {
        names.add(material.name);
      }
    }
  });
  return [...names].sort();
}

/** Tên node bánh xe có trong model (kiểm C-C). */
export function wheelNames(root: Object3D): readonly string[] {
  return wheelNodes(root)
    .map((node) => node.name)
    .sort();
}

/** Kích thước bao của model đã nạp (kiểm C4: mét, gốc ở tâm sàn). */
export function modelBounds(root: Object3D): { readonly min: Vector3; readonly max: Vector3; readonly size: Vector3 } {
  const box = new Box3().setFromObject(root);
  const size = new Vector3();
  box.getSize(size);
  return { min: box.min, max: box.max, size };
}

/** Kích thước kỳ vọng theo C4 (dài, rộng, cao) — để test so với GLB. */
export function expectedSize(model: CarModel): readonly [number, number, number] {
  return CAR_DIMENSIONS_M[model];
}

/** Gốc chứa một xe đã đặt vào cảnh (để P5 cập nhật pose mỗi frame). */
export interface PlacedCar {
  readonly root: Group;
  readonly model: CarModel;
  readonly color: CarColor;
  readonly scale: number;
  readonly slotId: string | null;
}

/** Màu hex của một màu xe (C4) — tiện cho UI/legend. */
export function carColorHex(color: CarColor): string {
  return CAR_COLOR_HEX[color];
}

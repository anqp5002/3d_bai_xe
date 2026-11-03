/**
 * Test nạp **file GLB thật** của P3 trong Node (P4a mục 3).
 *
 * Kiểm đúng những gì C-C bắt buộc và những gì P3 đã xuất:
 * kích thước C4 (mét), gốc ở tâm sàn, đủ 4 material, 4 bánh `wheel_*`,
 * và **mũi xe nằm ở -Z của glTF** (đèn trước z âm).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Material, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CAR_MATERIALS,
  carMaterialNames,
  carModelUrl,
  carRotationY,
  expectedSize,
  modelBounds,
  wheelNames,
} from './carModel';
import { CAR_MODELS, type CarModel } from '../contracts/sim';

const PUBLIC_DIR = resolve(process.cwd(), 'public');

/** Đọc GLB từ `public/assets/cars/` và parse bằng loader chính thức của three. */
async function loadCar(model: CarModel): Promise<Object3D> {
  const url = carModelUrl(model);
  const path = resolve(PUBLIC_DIR, url.replace(/^\//, ''));
  const buffer = readFileSync(path);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(arrayBuffer, '');
  return gltf.scene;
}

/** Tâm của các đỉnh thuộc material `name` (để kiểm đèn trước/sau nằm phía nào). */
function centroidOfMaterial(root: Object3D, name: string): Vector3 | null {
  const sum = new Vector3();
  let count = 0;
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const raw: unknown = child.material;
    const materials: readonly Material[] = Array.isArray(raw)
      ? (raw as readonly Material[])
      : [raw as Material];
    const has = materials.some((material) => material.name === name);
    if (!has) {
      return;
    }
    const geometry: unknown = child.geometry;
    if (!(geometry instanceof BufferGeometry)) {
      return;
    }
    const position: unknown = geometry.getAttribute('position');
    if (!(position instanceof BufferAttribute)) {
      return;
    }
    for (let index = 0; index < position.count; index += 1) {
      const point = new Vector3().fromBufferAttribute(position, index);
      point.applyMatrix4(child.matrixWorld);
      sum.add(point);
      count += 1;
    }
  });
  return count === 0 ? null : sum.divideScalar(count);
}

describe.each(CAR_MODELS)('render/carModel — nạp %s.glb', (model) => {
  it('kích thước đúng C4 (mét), sai ≤ 2 cm', async () => {
    const root = await loadCar(model);
    const { size } = modelBounds(root);
    const [length, width, height] = expectedSize(model);
    // glTF Y-up: x = rộng, y = cao, z = dài (mũi ở -Z).
    expect(Math.abs(size.x - width)).toBeLessThan(0.02);
    expect(Math.abs(size.y - height)).toBeLessThan(0.02);
    expect(Math.abs(size.z - length)).toBeLessThan(0.02);
  });

  it('gốc ở tâm sàn: min y = 0, tâm x/z ≈ 0', async () => {
    const root = await loadCar(model);
    const { min, max } = modelBounds(root);
    expect(Math.abs(min.y)).toBeLessThan(0.005);
    expect(Math.abs((min.x + max.x) / 2)).toBeLessThan(0.02);
    expect(Math.abs((min.z + max.z) / 2)).toBeLessThan(0.02);
  });

  it('có đủ 4 material bắt buộc (C-C)', async () => {
    const root = await loadCar(model);
    const names = carMaterialNames(root);
    for (const required of CAR_MATERIALS) {
      expect(names, `${model} thiếu material ${required}`).toContain(required);
    }
  });

  it('có 4 bánh tên wheel_* (C-C)', async () => {
    const root = await loadCar(model);
    const wheels = wheelNames(root);
    expect(wheels.length).toBeGreaterThanOrEqual(4);
    expect(wheels).toEqual(['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']);
  });

  it('mũi xe ở -Z glTF: đèn trước z < đèn sau z', async () => {
    const root = await loadCar(model);
    const front = centroidOfMaterial(root, 'light_front');
    const rear = centroidOfMaterial(root, 'light_rear');
    expect(front).not.toBeNull();
    expect(rear).not.toBeNull();
    expect(front!.z).toBeLessThan(rear!.z);
  });

  it('paint đổi màu được: material `paint` dùng baseColor, không texture', async () => {
    const root = await loadCar(model);
    let found = false;
    root.traverse((child) => {
      if (!(child instanceof Mesh)) {
        return;
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial && material.name === 'paint') {
          found = true;
          expect(material.map).toBeNull();
        }
      }
    });
    expect(found).toBe(true);
  });

  it('xoay theo heading đưa mũi về đúng hướng world', async () => {
    const root = await loadCar(model);
    const front = centroidOfMaterial(root, 'light_front');
    const rear = centroidOfMaterial(root, 'light_rear');
    expect(front).not.toBeNull();
    expect(rear).not.toBeNull();
    // Vector mũi trong không gian model = front - rear.
    const noseLocal = front!.clone().sub(rear!).normalize();
    expect(noseLocal.z).toBeLessThan(-0.5);

    // Sau khi áp rotation.y = carRotationY(heading), mũi phải trùng (cos, 0, -sin).
    for (const heading of [0, Math.PI / 2, -Math.PI / 2]) {
      const rotation = carRotationY(heading);
      const nose = noseLocal.clone().applyAxisAngle(new Vector3(0, 1, 0), rotation);
      expect(nose.x).toBeCloseTo(Math.cos(heading), 3);
      expect(nose.z).toBeCloseTo(-Math.sin(heading), 3);
    }
  });
});

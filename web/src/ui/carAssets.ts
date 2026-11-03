/** Nạp 3 model xe GLB một lần cho mọi khung nhìn (P4a mục 3; P9 dùng lại). */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Object3D } from 'three';
import type { CarModel } from '../contracts/sim';
import { carModelUrl } from '../render/carModel';

let cached: Promise<ReadonlyMap<CarModel, Object3D>> | null = null;

async function load(): Promise<ReadonlyMap<CarModel, Object3D>> {
  const loader = new GLTFLoader();
  const models = new Map<CarModel, Object3D>();
  for (const model of ['sedan', 'suv', 'hatch'] as const) {
    const gltf = await loader.loadAsync(carModelUrl(model));
    models.set(model, gltf.scene);
  }
  return models;
}

/** Promise dùng chung: lần đầu nạp, các lần sau trả cùng kết quả. */
export function loadCarTemplates(): Promise<ReadonlyMap<CarModel, Object3D>> {
  if (cached === null) {
    cached = load();
  }
  return cached;
}

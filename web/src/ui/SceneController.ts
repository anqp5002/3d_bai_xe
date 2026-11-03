/**
 * Cầu nối Three.js cho UI P9: dựng cảnh từ `lot`, đặt/xoá xe theo `SimState`, đổi
 * chế độ xem và nhận click (chọn xe / chọn ô).
 *
 * Chỉ **đọc** lớp `render/` (buildScene, createRenderView, carModel) và `sim/` (hình học
 * `pointInPolygon`), không sửa chúng. Toàn bộ DOM/WebGL nằm trong file này, nên store và
 * test logic vẫn chạy bằng Node.
 */

import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  RingGeometry,
  Vector3,
} from 'three';
import type { Material, Object3D, Vector2 } from 'three';
import type { LotMap, SlotId } from '../contracts/lot';
import type { EnvKeyframe } from '../contracts/env';
import type { CarModel, SimState } from '../contracts/sim';
import { carTransform, paintCar, spinWheels } from '../render/carModel';
import { buildScene, type BuiltScene } from '../render/scene';
import { createRenderView, type RenderView } from '../render/renderView';
import type { CameraCount, CameraViewMode } from '../render/cameraGeometry';
import {
  applyEnvAtTime,
  attachLampPointLights,
  collectLampsFromScene,
  createEnvLayers,
  type EnvApplyResult,
  type EnvLayers,
} from '../render/env/applyEnv';
import { pointInPolygon } from '../sim/collision';

/** Kết quả click trên khung xem. */
export type PickResult =
  | { readonly kind: 'car'; readonly carId: string }
  | { readonly kind: 'slot'; readonly slotId: SlotId }
  | null;

export interface SceneControllerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly lot: LotMap;
  readonly mode: CameraViewMode;
  readonly count: CameraCount;
  readonly antialias?: boolean;
  /** Bóng đổ cho xe (export tắt cho nhanh). */
  readonly shadows?: boolean;
  /** Bật lớp môi trường P8 (mây/mưa/đèn/trời) — chỉ export dùng. */
  readonly environment?: boolean;
  /** Seed cho mây/mưa của P8 (thường = scenario.seed). */
  readonly envSeed?: number;
}

interface CarEntry {
  readonly root: Object3D;
}

function findGroup(scene: Object3D, name: string): Group {
  const found: unknown = scene.getObjectByName(name);
  if (!(found instanceof Group)) {
    throw new Error(`Không tìm thấy group "${name}" trong cảnh`);
  }
  const group: Group = found as Group;
  return group;
}

function eachMaterial(material: unknown, visit: (item: Material) => void): void {
  if (Array.isArray(material)) {
    for (const item of material as readonly Material[]) {
      visit(item);
    }
    return;
  }
  visit(material as Material);
}

function disposeMaterials(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const mesh = child as Mesh;
    eachMaterial(mesh.material, (material) => material.dispose());
  });
}

/** `Object3D.clone` chia sẻ material; phải nhân bản để mỗi xe có màu riêng. */
function cloneMaterials(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const current: unknown = child.material;
    if (Array.isArray(current)) {
      child.material = (current as readonly Material[]).map((material) =>
        material.clone(),
      );
      return;
    }
    child.material = (current as Material).clone();
  });
}

export class SceneController {
  private readonly lot: LotMap;
  private readonly built: BuiltScene;
  private readonly view: RenderView;
  private readonly cars: Group;
  private readonly carEntries = new Map<string, CarEntry>();
  private readonly raycaster = new Raycaster();
  private readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly shadows: boolean;
  private templates: ReadonlyMap<CarModel, Object3D> | null = null;
  private envLayers: EnvLayers | null = null;

  constructor(options: SceneControllerOptions) {
    this.lot = options.lot;
    this.shadows = options.shadows ?? true;

    this.built = buildScene(options.lot, {
      // Luôn dựng helper để có thể bật/tắt khi đổi chế độ, không phải dựng lại cảnh.
      showGrid: true,
      showMarkings: true,
      shadows: this.shadows,
    });
    this.built.groups.helpers.visible = options.mode === 'free';
    this.cars = findGroup(this.built.scene, 'cars');
    if (options.environment === true) {
      this.envLayers = createEnvLayers(this.built.scene, options.envSeed ?? 1);
      collectLampsFromScene(this.envLayers, this.built.scene);
      attachLampPointLights(
        this.envLayers,
        this.built.scene,
        this.lot.decor.lamps.map(
          (lamp) =>
            [lamp.pos[0], lamp.height_m + 0.2, -lamp.pos[1]] as const,
        ),
      );
    }
    this.view = createRenderView(
      {
        lot: options.lot,
        mode: options.mode,
        count: options.count,
        canvas: options.canvas,
        antialias: options.antialias ?? true,
      },
      this.built.scene,
    );

    this.ring = new Mesh(
      new RingGeometry(1.1, 1.45, 32),
      new MeshBasicMaterial({
        color: 0xffd166,
        side: DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;
    this.ring.visible = false;
    this.built.scene.add(this.ring);
  }

  /** Gán bộ template GLB đã nạp (gọi một lần sau khi `loadCarTemplates` xong). */
  setTemplates(templates: ReadonlyMap<CarModel, Object3D>): void {
    this.templates = templates;
  }

  setMode(mode: CameraViewMode, count: CameraCount): void {
    this.view.setMode(mode, count);
    this.built.groups.helpers.visible = mode === 'free';
    this.view.render();
  }

  /**
   * Đặt toàn bộ xe của `state` vào cảnh: tạo xe mới, cập nhật pose xe cũ, xoá xe đã ra.
   * Không tự render để export có thể gom một lượt.
   */
  applyState(state: SimState, selectedCarId: string | null): void {
    if (this.templates === null) {
      return;
    }
    const present = new Set<string>();
    for (const car of state.cars) {
      if (car.state === 'exited') {
        continue;
      }
      present.add(car.id);
      let entry = this.carEntries.get(car.id);
      if (entry === undefined) {
        const template = this.templates.get(car.model);
        if (template === undefined) {
          throw new Error(`Không có model GLB cho "${car.model}"`);
        }
        const root = template.clone(true);
        root.name = car.id;
        cloneMaterials(root);
        paintCar(root, car.color);
        root.traverse((child) => {
          if (child instanceof Mesh) {
            child.castShadow = this.shadows;
            child.receiveShadow = this.shadows;
          }
        });
        this.cars.add(root);
        entry = { root };
        this.carEntries.set(car.id, entry);
      }
      const transform = carTransform(car.pose.x, car.pose.y, car.pose.th);
      entry.root.position.set(...transform.position);
      entry.root.rotation.y = transform.rotationY;
      entry.root.scale.setScalar(car.scale);
      if (car.route_s !== undefined) {
        spinWheels(entry.root, car.route_s);
      }
    }

    for (const [carId, entry] of [...this.carEntries]) {
      if (present.has(carId)) {
        continue;
      }
      this.cars.remove(entry.root);
      disposeMaterials(entry.root);
      this.carEntries.delete(carId);
    }

    const selected = selectedCarId === null ? undefined : this.carEntries.get(selectedCarId);
    if (selected === undefined) {
      this.ring.visible = false;
    } else {
      this.ring.visible = true;
      this.ring.position.set(
        selected.root.position.x,
        0.06,
        selected.root.position.z,
      );
    }
  }

  /**
   * Áp môi trường P8 theo mốc tại `t_s` (giây video) — chỉ có tác dụng khi tạo
   * controller với `environment: true` (export). Trả `null` nếu không bật.
   */
  applyEnvironment(
    keyframes: readonly EnvKeyframe[],
    t_s: number,
  ): EnvApplyResult | null {
    if (this.envLayers === null) {
      return null;
    }
    return applyEnvAtTime(
      {
        scene: this.built.scene,
        lights: this.built.lights,
        layers: this.envLayers,
      },
      keyframes,
      t_s,
    );
  }

  /** Render một frame; trả canvas đang dùng (640×640 hoặc 800×640 tuỳ chế độ). */
  render(): HTMLCanvasElement {
    return this.view.render();
  }

  /** Click theo toạ độ chuẩn hoá NDC (−1…1). Ưu tiên xe, rồi tới ô đỗ. */
  pickNdc(ndc: Vector2): PickResult {
    this.raycaster.setFromCamera(ndc, this.view.camera);
    const roots = [...this.carEntries.values()].map((entry) => entry.root);
    if (roots.length > 0) {
      const hits = this.raycaster.intersectObjects(roots, true);
      const first = hits[0];
      if (first !== undefined) {
        let object: Object3D | null = first.object;
        while (object !== null) {
          if (this.carEntries.has(object.name)) {
            return { kind: 'car', carId: object.name };
          }
          object = object.parent;
        }
      }
    }

    const target = new Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, target) === null) {
      return null;
    }
    const point: readonly [number, number] = [target.x, -target.z];
    const slot = this.lot.slots.find((candidate) => pointInPolygon(point, candidate.polygon));
    return slot === undefined ? null : { kind: 'slot', slotId: slot.id };
  }

  dispose(): void {
    for (const entry of this.carEntries.values()) {
      this.cars.remove(entry.root);
      disposeMaterials(entry.root);
    }
    this.carEntries.clear();

    this.ring.geometry.dispose();
    this.ring.material.dispose();

    for (const [name, group] of Object.entries(this.built.groups)) {
      if (name === 'cars') {
        continue;
      }
      group.traverse((child) => {
        if (!(child instanceof Mesh)) {
          return;
        }
        const mesh = child as Mesh;
        mesh.geometry.dispose();
        eachMaterial(mesh.material, (material) => material.dispose());
      });
      group.clear();
    }

    if (this.envLayers !== null) {
      const layers = this.envLayers;
      this.built.scene.remove(layers.root);
      layers.root.traverse((child) => {
        if (!(child instanceof Mesh)) {
          return;
        }
        const mesh = child as Mesh;
        mesh.geometry.dispose();
        eachMaterial(mesh.material, (material) => material.dispose());
      });
      layers.rain.geometry.dispose();
      layers.rainMaterial.dispose();
      layers.skyTexture.dispose();
      for (const light of layers.lampPointLights) {
        this.built.scene.remove(light);
      }
      layers.root.clear();
      this.envLayers = null;
    }
    this.view.dispose();
  }
}

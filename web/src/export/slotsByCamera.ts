/**
 * Chia ô theo camera + sinh `parking_slots_cam{1,2}.json` (BE §5, G0).
 *
 * Quy tắc (BE §5): một ô thuộc cam khi **≥ 80 % diện tích đa giác** nằm trong khung cam.
 * Ô ở vùng chồng lấn 240–400 px thoả cả hai nên có mặt ở **cả hai file với cùng `id`**.
 */

import type { LotMap, Slot, Vec2 } from '../contracts/lot';
import {
  CAM_MEMBERSHIP_RATIO,
  TechgarConfigError,
  round4,
  techgarImageSize,
} from './techgarConfig';
/** Diện tích đa giác (shoelace), luôn dương. */
export function polygonArea(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Cắt đa giác lồi bằng nửa mặt phẳng `x >= edge` (Sutherland–Hodgman). */
function clipLeft(polygon: readonly Vec2[], edge: number): Vec2[] {
  const output: Vec2[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentInside = current[0] >= edge;
    const nextInside = next[0] >= edge;
    if (currentInside) {
      output.push(current);
    }
    if (currentInside !== nextInside) {
      const ratio = (edge - current[0]) / (next[0] - current[0]);
      output.push([edge, current[1] + (next[1] - current[1]) * ratio]);
    }
  }
  return output;
}

/** Cắt đa giác lồi bằng nửa mặt phẳng `x <= edge`. */
function clipRight(polygon: readonly Vec2[], edge: number): Vec2[] {
  const output: Vec2[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentInside = current[0] <= edge;
    const nextInside = next[0] <= edge;
    if (currentInside) {
      output.push(current);
    }
    if (currentInside !== nextInside) {
      const ratio = (edge - current[0]) / (next[0] - current[0]);
      output.push([edge, current[1] + (next[1] - current[1]) * ratio]);
    }
  }
  return output;
}

/**
 * Tỉ lệ diện tích đa giác ô nằm trong khung cam `[u0, u1)` của ảnh 640.
 * Dùng toạ độ **ảnh** (`polygon_px`) vì khung cam là giới hạn theo cột ảnh.
 */
export function visibleRatioInCamera(slot: Slot, crop: readonly [number, number]): number {
  const total = polygonArea(slot.polygon_px);
  if (total <= 0) {
    throw new TechgarConfigError(`visibleRatioInCamera: ô ${slot.id} có diện tích ảnh bằng 0`);
  }
  const clipped = clipRight(clipLeft(slot.polygon_px, crop[0]), crop[1]);
  if (clipped.length < 3) {
    return 0;
  }
  return polygonArea(clipped) / total;
}

/** Ô có thuộc cam không (>= 80 % diện tích trong khung, BE §5). */
export function belongsToCamera(slot: Slot, crop: readonly [number, number]): boolean {
  return visibleRatioInCamera(slot, crop) >= CAM_MEMBERSHIP_RATIO;
}

/** Polygon ô trên ảnh của một cam, đổi về toạ độ khung cắt (`u - u0`), nhân hệ số `scale`. */
export function slotPolygonForCamera(
  slot: Slot,
  cropU0: number,
  scale = 1,
): { x: number; y: number }[] {
  return slot.polygon_px.map(([u, v]) => ({
    x: round4((u - cropU0) * scale),
    y: round4(v * scale),
  }));
}

/** Tâm ô trên ảnh của một cam (đã trừ `cropU0`), nhân hệ số `scale`. */
export function slotCenterForCamera(
  slot: Slot,
  cropU0: number,
  scale = 1,
): { x: number; y: number } {
  const us = slot.polygon_px.map((point) => point[0]);
  const vs = slot.polygon_px.map((point) => point[1]);
  return {
    x: round4(
      (us.reduce((sum, value) => sum + value, 0) / us.length - cropU0) * scale,
    ),
    y: round4((vs.reduce((sum, value) => sum + value, 0) / vs.length) * scale),
  };
}

/** Một ô trong file `parking_slots_cam{1,2}.json` (đúng schema session toi1). */
export interface SlotsFileEntry {
  readonly id: string;
  readonly type: 'polygon';
  readonly polygon: readonly { readonly x: number; readonly y: number }[];
  readonly center: { readonly x: number; readonly y: number };
  readonly status: 'empty';
}

/** File `parking_slots_cam{1,2}.json` (đúng schema session toi1, `REPORT_P0` (b)). */
export interface SlotsFile {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly slots: readonly SlotsFileEntry[];
}

/** Sinh file slots cho một cam; chỉ gồm ô thuộc cam đó (BE §5), nhân hệ số `scale`. */
export function slotsForCamera(
  lot: LotMap,
  crop: readonly [number, number],
  cropU0: number,
  scale = 1,
): SlotsFile {
  const slots = lot.slots
    .filter((slot) => belongsToCamera(slot, crop))
    .map(
      (slot): SlotsFileEntry => ({
        id: slot.id,
        type: 'polygon',
        polygon: slotPolygonForCamera(slot, cropU0, scale),
        center: slotCenterForCamera(slot, cropU0, scale),
        status: 'empty',
      }),
    );
  const size = techgarImageSize(scale);
  return {
    imageWidth: size.width,
    imageHeight: size.height,
    slots,
  };
}

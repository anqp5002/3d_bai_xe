/**
 * BRIEF_P15 mục B: mask ROI phải bao **toàn mặt bãi xe chạy được** trong khung cam.
 *
 * Kiểm bằng hình học thật từ `lot`:
 * - mọi điểm của `buildEntryRoute`/`buildExitRoute` nằm trong khung cam đều nằm trong mask;
 * - vạch đếm (`countLines`) nằm trong mask.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/export/roiMaskCoverage.test.ts`
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LotMap, Vec2 } from '../contracts/lot';
import { buildEntryRoute, buildExitRoute, buildRoadNetwork } from '../sim/network';
import { buildRoiMask, CAMERA_CROPS } from './techgarBundle';
import { buildCountLines } from './countLines';
import { TECHGAR_SCALE, techgarImageSize } from './techgarConfig';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOT = JSON.parse(
  readFileSync(resolve(HERE, '../../../data/lot/lot_pucpr.json'), 'utf8'),
) as LotMap;
const SPEED = 10 / 3.6;

/** Mask là hình chữ nhật (p1..p4 theo thứ tự) — kiểm điểm nằm trong. */
function insideMask(
  mask: { readonly polygon: readonly { readonly x: number; readonly y: number }[] },
  u: number,
  v: number,
): boolean {
  const xs = mask.polygon.map((p) => p.x);
  const ys = mask.polygon.map((p) => p.y);
  return (
    u >= Math.min(...xs) && u <= Math.max(...xs) && v >= Math.min(...ys) && v <= Math.max(...ys)
  );
}

describe('mask ROI phủ toàn mặt bãi (BRIEF_P15 mục B)', () => {
  const network = buildRoadNetwork(LOT);

  it('mọi điểm route nằm trong khung cam đều nằm trong mask', () => {
    const masks = {
      cam1: buildRoiMask(LOT, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0], TECHGAR_SCALE),
      cam2: buildRoiMask(LOT, CAMERA_CROPS.cam2, CAMERA_CROPS.cam2[0], TECHGAR_SCALE),
    };
    const outside: string[] = [];
    let checked = 0;
    for (const slot of LOT.slots) {
      for (const build of [buildEntryRoute, buildExitRoute]) {
        const route = build(LOT, network, slot, SPEED);
        if (route === null) {
          continue;
        }
        for (const point of route.points) {
          const [u, v] = projectToImage(LOT, point.pose.x, point.pose.y);
          for (const [cam, crop] of [
            ['cam1', CAMERA_CROPS.cam1],
            ['cam2', CAMERA_CROPS.cam2],
          ] as const) {
            // Chỉ kiểm điểm nằm trong khung cam (ngoài khung thì mask không có nghĩa vụ phủ).
            if (u < crop[0] || u >= crop[1] || v < 0 || v >= LOT.camera.res[1]) {
              continue;
            }
            checked += 1;
            const localU = (u - crop[0]) * TECHGAR_SCALE;
            const localV = v * TECHGAR_SCALE;
            if (!insideMask(masks[cam], localU, localV)) {
              outside.push(
                `${cam} ô ${slot.id}: (${localU.toFixed(0)}, ${localV.toFixed(0)}) ngoài mask`,
              );
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(outside.slice(0, 5)).toEqual([]);
  });

  it('vạch đếm nằm trong mask của cả hai cam', () => {
    const lines = buildCountLines(LOT);
    for (const [cam, crop] of [
      ['cam1', CAMERA_CROPS.cam1],
      ['cam2', CAMERA_CROPS.cam2],
    ] as const) {
      const mask = buildRoiMask(LOT, crop, crop[0], TECHGAR_SCALE);
      for (const line of [lines.entry, lines.exit]) {
        for (const point of [line.p1, line.p2]) {
          const [u, v] = projectToImage(LOT, point[0], point[1]);
          if (u < crop[0] || u >= crop[1] || v < 0 || v >= LOT.camera.res[1]) {
            continue;
          }
          const localU = (u - crop[0]) * TECHGAR_SCALE;
          const localV = v * TECHGAR_SCALE;
          expect(
            insideMask(mask, localU, localV),
            `${cam}: vạch (${localU.toFixed(0)}, ${localV.toFixed(0)}) ngoài mask`,
          ).toBe(true);
        }
      }
    }
  });

  it('mask đúng cỡ ảnh đã phóng', () => {
    const size = techgarImageSize(TECHGAR_SCALE);
    const mask = buildRoiMask(LOT, CAMERA_CROPS.cam1, CAMERA_CROPS.cam1[0], TECHGAR_SCALE);
    expect(mask.image_size).toEqual([size.width, size.height]);
  });
});

/** Chiếu (x, y) mét xuống pixel ảnh 640 — cùng công thức `project()` của sim. */
function projectToImage(lot: LotMap, x: number, y: number): Vec2 {
  const pitch = (lot.camera.pitch_deg * Math.PI) / 180;
  const z = y * Math.cos(pitch) + lot.camera.height_m * Math.sin(pitch);
  const u = lot.camera.res[0] / 2 + (lot.camera.f_px * x) / z;
  const v =
    lot.camera.res[1] / 2 +
    (lot.camera.f_px * (-y * Math.sin(pitch) + lot.camera.height_m * Math.cos(pitch))) / z;
  return [u, v];
}

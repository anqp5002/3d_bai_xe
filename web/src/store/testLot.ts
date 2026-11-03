/**
 * Bãi tổng hợp nhỏ cho test store/UI (P9b). **Chỉ test import** — không dùng trong app.
 *
 * Hình học giống lot PUCPR thu nhỏ: một làn một chiều từ cổng vào (tây) tới cổng ra
 * (đông), 5 ô hai bên, đủ để `buildEntryRoute`/`buildExitRoute` chạy.
 */

import type { CameraModel, LotMap, Slot, Vec2, Vec2Px } from '../contracts/lot';

const CAMERA: CameraModel = {
  pitch_deg: 80,
  f_px: 288,
  height_m: 33.6,
  res: [640, 640],
  cam1_x: [0, 400],
  cam2_x: [240, 640],
};

const PX: readonly [Vec2Px, Vec2Px, Vec2Px, Vec2Px] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function makeSlot(id: Slot['id'], x: number, side: 1 | -1, row: string): Slot {
  const centerY = side * 5;
  const depth = 4.8;
  const width = 2.5;
  const heading = side === 1 ? Math.PI / 2 : -Math.PI / 2;
  const forward: Vec2 = [Math.cos(heading), Math.sin(heading)];
  const lateral: Vec2 = [-Math.sin(heading), Math.cos(heading)];
  const corner = (f: number, s: number): Vec2 => [
    x + forward[0] * (depth / 2) * f + lateral[0] * (width / 2) * s,
    centerY + forward[1] * (depth / 2) * f + lateral[1] * (width / 2) * s,
  ];
  return {
    id,
    row,
    center: [x, centerY],
    heading,
    polygon: [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)],
    polygon_px: PX,
    width_m: width,
    reachable: true,
  };
}

export function makeTestLot(): LotMap {
  return {
    name: 'test-lot',
    camera: CAMERA,
    slots: [
      makeSlot('S001', -8, 1, '1'),
      makeSlot('S002', 0, 1, '1'),
      makeSlot('S003', 8, 1, '1'),
      makeSlot('S004', -4, -1, '2'),
      makeSlot('S005', 4, -1, '2'),
    ],
    aisles: [
      {
        id: 'LANE',
        polyline: [
          [-20, 0],
          [20, 0],
        ],
        width_m: 5,
        oneway: true,
      },
    ],
    gates: {
      in: {
        p1: [-20, -2],
        p2: [-20, 2],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [-25, 0, 0],
        despawn: [-19, 0],
      },
      out: {
        p1: [20, -2],
        p2: [20, 2],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [19, 0, 0],
        despawn: [25, 0],
      },
    },
    decor: { grass: [], curbs: [], asphalt: [], trees: [], lamps: [] },
  };
}

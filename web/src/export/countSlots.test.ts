/**
 * ANS_17: phân loại ô theo **lộ trình thật** (không theo số hàng).
 *
 * Với mỗi ô: chạy `buildEntryRoute` / `buildExitRoute` của `sim/`, đếm số lần tâm xe cắt vạch
 * đếm vào / vạch đếm ra — **tính cả cung vào ô và lùi ra** (ANS_16 mục 9).
 *
 * Ô **hợp lệ** = route vào cắt vạch vào **đúng 1 lần** (và lần cắt nằm trên A2)
 *              VÀ route ra cắt vạch ra **đúng 1 lần** (trên A2).
 * Ô **bị cờ** = cắt 0 lần, ≥ 2 lần, hoặc route đi qua A3 (camera không phủ quanh `x = ±20`).
 *
 * File này vừa là **test** (assert danh sách cờ sinh từ lộ trình, không hard-code số hàng),
 * vừa là **công cụ** ghi `data/lot/count_slots.json` để GT/verify/README dùng lại.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/export/countSlots.test.ts`
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LotMap, Slot, Vec2 } from '../contracts/lot';
import type { Route } from '../contracts/sim';
import { buildEntryRoute, buildExitRoute, buildRoadNetwork } from '../sim/network';
import { countLineFor, COUNT_LINE_ABS_X_M } from './countLines';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOT_PATH = resolve(HERE, '../../../data/lot/lot_pucpr.json');
const OUT_PATH = resolve(HERE, '../../../data/lot/count_slots.json');

/** Vận tốc dùng khi dựng route — chỉ ảnh hưởng độ dài cung, không ảnh hưởng hình dạng. */
const SPEED = 10 / 3.6;

/** Vạch đếm: đoạn dọc `x = ±COUNT_LINE_ABS_X_M`, `y` lấy đúng dải của cổng vẽ trên A2. */
const A2_Y_BAND = 3.0;

/** Bán kính vùng A3 (`y ≈ −16,27`, bề rộng 5,0 m) — route đi vào đây là "qua A3". */
const A3_Y = -16.27;
const A3_BAND = 2.5;

export interface SlotClassification {
  readonly slot: string;
  readonly row: string;
  readonly centerX: number;
  /** Số lần route vào cắt vạch vào (đếm cả mọi đoạn của polyline). */
  readonly entry_crossings: number;
  /** Số lần route ra cắt vạch ra. */
  readonly exit_crossings: number;
  /** Có đoạn nào của route nằm trong dải A3 không. */
  readonly passes_a3: boolean;
  /** `null` = hợp lệ; ngược lại là mã lý do. */
  readonly flag: 'before_count_line' | 'route_not_on_A2' | 'camera_blind_A3' | null;
  readonly reason: string;
}

function crosses(from: Vec2, to: Vec2, xLine: number): boolean {
  return (from[0] > xLine) !== (to[0] > xLine);
}

/**
 * Đếm **mọi** lần polyline cắt vạch dọc `x = xLine`, kèm `y` tại điểm cắt.
 *
 * Cố ý đếm **tất cả** (không lọc theo dải A2): một lộ trình có thể cắt vạch
 * ở A2 **và** ở A1/V_east_s. Lọc sớm sẽ giấu mất lần cắt thứ hai và làm ô sai được
 * xếp loại "hợp lệ" (đã mắc đúng lỗi này với S005: cắt ở y=3,2 và y=21,0).
 */
function crossingYs(points: readonly Vec2[], xLine: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!crosses(from, to, xLine)) {
      continue;
    }
    const span = to[0] - from[0];
    const t = span === 0 ? 0 : (xLine - from[0]) / span;
    out.push(from[1] + t * (to[1] - from[1]));
  }
  return out;
}

/** Số lần cắt nằm đúng trên dểi A2 (đây mới là lần đếm có giá trị). */
function countCrossingsOnA2(points: readonly Vec2[], xLine: number): number {
  return crossingYs(points, xLine).filter((y) => Math.abs(y - A2_Y_BAND) <= A2_Y_BAND).length;
}

/** Có đoạn nào của polyline đi vào dải A3 không (ngoài phần sát mép bãi). */
function passesA3(points: readonly Vec2[]): boolean {
  return points.some((point) => Math.abs(point[1] - A3_Y) <= A3_BAND);
}

/**
 * Toạ độ tâm xe đi theo route — chính là `points[].pose` (route đã chia nhỏ `MAX_ROUTE_STEP_M`).
 * Dùng tâm xe (không phải mũi) để khớp định nghĩa GT "tâm xe cắt vạch" (C9).
 */
function routePoints(route: Route | null): readonly Vec2[] {
  if (route === null) {
    return [];
  }
  return route.points.map((point) => [point.pose.x, point.pose.y] as Vec2);
}

export function classifySlots(lot: LotMap): SlotClassification[] {
  const network = buildRoadNetwork(lot);
  const out: SlotClassification[] = [];
  for (const slot of lot.slots) {
    const entry = buildEntryRoute(lot, network, slot, SPEED);
    const exit = buildExitRoute(lot, network, slot, SPEED);
    const entryPts = routePoints(entry);
    const exitPts = routePoints(exit);

    const entryCross = countCrossingsOnA2(entryPts, COUNT_LINE_ABS_X_M);
    const exitCross = countCrossingsOnA2(exitPts, -COUNT_LINE_ABS_X_M);
    // Tổng số lần cắt (kể cả ngoài A2) — dùng để phát hiện cắt thừa ở làn khác.
    const entryCrossAll = crossingYs(entryPts, COUNT_LINE_ABS_X_M).length;
    const exitCrossAll = crossingYs(exitPts, -COUNT_LINE_ABS_X_M).length;
    // Cắt CHÉO vạch: route vào cắt vạch RA, hoặc route ra cắt vạch VÀO.
    // Đây là cái bẫy thật: ô gần vạch thì xe chạy vượt qua vạch rồi vòng lại vào ô
    // ⇒ controller thấy thêm một cúp cắt giả (ví dụ S010: vào cắt V 1 lần nhưng cũng
    // cắt R 1 lần; đo động học thật cho 4 cắt trên A2). Phải loại ô đó.
    const entryCrossesExitLine = countCrossingsOnA2(entryPts, -COUNT_LINE_ABS_X_M);
    const exitCrossesEntryLine = countCrossingsOnA2(exitPts, COUNT_LINE_ABS_X_M);
    const crossesBoth = entryCrossesExitLine > 0 || exitCrossesEntryLine > 0;
    const throughA3 = passesA3(entryPts) || passesA3(exitPts);

    let flag: SlotClassification['flag'] = null;
    let reason = 'lộ trình cắt vạch đúng 1 lần mỗi chiều trên A2';
    if (throughA3) {
      flag = 'camera_blind_A3';
      reason = 'lộ trình đi qua A3 — camera không phủ quanh x = ±20 nên không cấp/giữ được ID';
    } else if (entryCross === 0 || exitCross === 0) {
      flag = 'before_count_line';
      reason = `lộ trình không cắt vạch (vào ${String(entryCross)} lần, ra ${String(exitCross)} lần)`;
    } else if (crossesBoth) {
      flag = 'route_not_on_A2';
      reason =
        `lộ trình cắt CHÉO vạch (vào cắt vạch ra ${String(entryCrossesExitLine)} lần, ` +
        `ra cắt vạch vào ${String(exitCrossesEntryLine)} lần) — xe vượt qua vạch rồi vòng lại`;
    } else if (entryCrossAll > 1 || exitCrossAll > 1) {
      // Cắt nhiều lần (dù chỉ 1 lần trên A2) vẫn là không dùng được: controller sẽ đếm thừa.
      flag = 'route_not_on_A2';
      reason =
        `lộ trình cắt vạch nhiều lần (vào ${String(entryCrossAll)}, ra ${String(exitCrossAll)}; ` +
        `chỉ ${String(entryCross)}/${String(exitCross)} lần trên A2)`;
    }

    out.push({
      slot: slot.id,
      row: slot.row,
      centerX: slot.center[0],
      entry_crossings: entryCross,
      exit_crossings: exitCross,
      passes_a3: throughA3,
      flag,
      reason,
    });
  }
  return out;
}

function realLot(): LotMap {
  return JSON.parse(readFileSync(LOT_PATH, 'utf8')) as LotMap;
}

describe('ANS_17 — chi tiết một ô ngoài vạch nhưng route vẫn cắt đúng 1 lần', () => {
  it('S005 (x=+21,3) cắt vạch vào 2 lần (A2 và A1) nên PHẢI bị cờ', () => {
    const lot = realLot();
    const slot = lot.slots.find((item) => item.id === 'S005');
    expect(slot).toBeDefined();
    const network = buildRoadNetwork(lot);
    const route = buildEntryRoute(lot, network, slot as Slot, SPEED);
    expect(route).not.toBeNull();
    const pts = routePoints(route);
    const crossesList: { x: number; y: number }[] = [];
    for (let index = 0; index < pts.length - 1; index += 1) {
      const a = pts[index];
      const b = pts[index + 1];
      if ((a[0] > COUNT_LINE_ABS_X_M) !== (b[0] > COUNT_LINE_ABS_X_M)) {
        const span = b[0] - a[0];
        const t = span === 0 ? 0 : (COUNT_LINE_ABS_X_M - a[0]) / span;
        crossesList.push({ x: COUNT_LINE_ABS_X_M, y: a[1] + t * (b[1] - a[1]) });
      }
    }
    // S005 từng bị xếp loại "hợp lệ" vì bộ đếm lọc theo dải A2 và bỏ qua lần cắt ở A1.
    console.log(`S005 center=(${slot!.center[0].toFixed(1)}, ${slot!.center[1].toFixed(1)}) cat tai`, crossesList);
    expect(crossesList.length).toBeGreaterThan(1);
    // Và danh sách phân loại phải đã gắn cờ cho nó.
    const row = classifySlots(lot).find((item) => item.slot === 'S005');
    expect(row?.flag).not.toBeNull();
  });
});

describe('ANS_17 — phân loại ô theo lộ trình', () => {
  const lot = realLot();
  const results = classifySlots(lot);

  it('mọi ô đều có mặt trong kết quả', () => {
    expect(results).toHaveLength(lot.slots.length);
  });

  it('ô hợp lệ: route vào cắt vạch vào đúng 1 lần, route ra cắt vạch ra đúng 1 lần', () => {
    for (const row of results.filter((item) => item.flag === null)) {
      expect(row.entry_crossings, `${row.slot} entry`).toBe(1);
      expect(row.exit_crossings, `${row.slot} exit`).toBe(1);
      expect(row.passes_a3, `${row.slot} A3`).toBe(false);
    }
  });

  it('ô có cờ: luôn có lý do cụ thể', () => {
    for (const row of results.filter((item) => item.flag !== null)) {
      expect(row.reason.length, row.slot).toBeGreaterThan(10);
    }
  });

  it('không hard-code số hàng: danh sách cờ sinh từ lộ trình', () => {
    // Nếu ai đổi `COUNT_LINE_ABS_X_M` hoặc mạng đường, danh sách này đổi theo.
    // Kiểm mối liên hệ: mọi ô có `passes_a3` PHẢI bị cờ (không có ngoại lệ).
    for (const row of results) {
      if (row.passes_a3) {
        expect(row.flag, `${row.slot} qua A3 mà không bị cờ`).not.toBeNull();
      }
    }
  });

  it('ghi data/lot/count_slots.json để GT/verify/README dùng lại', () => {
    const payload = {
      note:
        'Phân loại ô đếm được cổng hay không, sinh từ lộ trình thật (ANS_17). ' +
        'Sinh bởi sim3d/web/src/export/countSlots.test.ts — đừng sửa tay.',
      count_line_abs_x_m: COUNT_LINE_ABS_X_M,
      valid: results.filter((item) => item.flag === null).map((item) => item.slot),
      flagged: results
        .filter((item) => item.flag !== null)
        .map((item) => ({
          slot: item.slot,
          row: item.row,
          center_x: Number(item.centerX.toFixed(2)),
          flag: item.flag,
          reason: item.reason,
          entry_crossings: item.entry_crossings,
          exit_crossings: item.exit_crossings,
          passes_a3: item.passes_a3,
        })),
    };
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
    expect(payload.valid.length + payload.flagged.length).toBe(lot.slots.length);
    expect(payload.flagged.length).toBeGreaterThan(0);
  });

  it('vạch đếm cách mọi đa giác ô ≥ 0,5 m (ANS_16 mục 8)', () => {
    // Vạch = đoạn dọc tại x = ±COUNT_LINE_ABS_X_M, dài theo dải cổng trên A2.
    const gate = lot.gates.in;
    const y0 = Math.min(gate.p1[1], gate.p2[1]);
    const y1 = Math.max(gate.p1[1], gate.p2[1]);
    for (const slot of lot.slots) {
      for (const sign of [1, -1]) {
        const line = countLineFor(gate, sign * COUNT_LINE_ABS_X_M);
        const distance = polygonSegmentDistance(slot, line, y0, y1);
        expect(distance, `${slot.id} vs vạch ${String(sign)}`).toBeGreaterThanOrEqual(0.5);
      }
    }
  });
});

/** Khoảng cách nhỏ nhất giữa đoạn vạch (`x`, y0..y1) và đa giác ô. */
function polygonSegmentDistance(
  slot: Slot,
  line: { readonly p1: Vec2; readonly p2: Vec2 },
  y0: number,
  y1: number,
): number {
  const ax = line.p1[0];
  const a: Vec2 = [ax, y0];
  const b: Vec2 = [ax, y1];
  const poly = slot.polygon;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < poly.length; index += 1) {
    const c = poly[index];
    const d = poly[(index + 1) % poly.length];
    if (segmentsIntersect(a, b, c, d)) {
      return 0;
    }
    best = Math.min(best, pointSegDistance(a, c, d), pointSegDistance(b, c, d),
      pointSegDistance(c, a, b), pointSegDistance(d, a, b));
  }
  return best;
}

function side(p: Vec2, q: Vec2, r: Vec2): number {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointSegDistance(p: Vec2, s: Vec2, e: Vec2): number {
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(p[0] - s[0], p[1] - s[1]);
  }
  const t = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy));
}

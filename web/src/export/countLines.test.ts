/**
 * Vạch đếm (P11 / ANS_14) — test hình học + GT + `gate_zones.json`.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/export`
 */

import { describe, expect, it } from 'vitest';
import type { LotMap, Vec2 } from '../contracts/lot';
import {
  buildCountLines,
  countLineDirection,
  COUNT_LINE_ABS_X_M,
  COUNT_LINE_MARGIN_M,
  crossesLine,
  crossingSign,
  lotWithCountLines,
  countLineFor,
} from './countLines';
import { buildGateZones } from './techgarBundle';
import { lotCenter } from './techgarConfig';
import { makeTestLot } from '../store/testLot';

/**
 * Lot thật (PUCPR) rút gọn: chỉ cần `gates` + `slots` + vài làn để kiểm khoảng cách.
 * Dùng `makeTestLot` của store nếu nó có `gates`; nếu không, dựng tối thiểu tại đây.
 */
function realLot(): LotMap {
  const lot = makeTestLot();
  return lot;
}

/**
 * Số đo THẬT từ `sim3d/tools/out/count_lines.json` (3 run K2/K4/K6, 19 mẫu).
 * Test canh để nếu ai đổi `COUNT_LINE_ABS_X_M` mà không đo lại thì đỏ ngay.
 */
const MEASURED = {
  carLengthMaxM: 5.17,
  /** Điểm cấp Global ID muộn nhất (x nhỏ nhất) khi vào. */
  entryDeepestM: 25.82,
  /** Điểm mất Global ID sớm nhất (x lớn nhất) khi ra. */
  exitShallowestM: -25.93,
  gateInXM: 36.21,
  gateOutXM: -36.92,
};

describe('countLines — vị trí vạch nằm trong miền đo được', () => {
  it('vạch vào sâu hơn (điểm cấp ID muộn nhất + 1 chiều dài xe)', () => {
    const maxAllowed = MEASURED.entryDeepestM - MEASURED.carLengthMaxM;
    expect(COUNT_LINE_ABS_X_M).toBeLessThanOrEqual(maxAllowed);
    // Và phải sâu hơn cổng vẽ (xe đi từ +x sang -x).
    expect(COUNT_LINE_ABS_X_M).toBeLessThan(MEASURED.gateInXM);
  });

  it('vạch ra nông hơn (điểm mất ID sớm nhất - 1 chiều dài xe)', () => {
    const minAllowed = MEASURED.exitShallowestM + MEASURED.carLengthMaxM;
    expect(-COUNT_LINE_ABS_X_M).toBeGreaterThanOrEqual(minAllowed);
    expect(-COUNT_LINE_ABS_X_M).toBeGreaterThan(MEASURED.gateOutXM);
  });

  it('biên còn lại khớp hằng số công bố', () => {
    const entryMargin = MEASURED.entryDeepestM - MEASURED.carLengthMaxM - COUNT_LINE_ABS_X_M;
    expect(entryMargin).toBeCloseTo(COUNT_LINE_MARGIN_M, 2);
  });
});

describe('countLines — dẫn xuất từ lot.gates, không sửa lot', () => {
  it('giữ nguyên y của cổng, chỉ đổi x (dấu x theo phía cổng của lot)', () => {
    const lot = realLot();
    const lines = buildCountLines(lot);
    expect(lines.entry.p1[1]).toBe(lot.gates.in.p1[1]);
    expect(lines.entry.p2[1]).toBe(lot.gates.in.p2[1]);
    // Vạch nằm cùng phía với cổng của nó, chỉ dịch vào trong.
    expect(Math.sign(lines.entry.p1[0])).toBe(Math.sign(lot.gates.in.p1[0]));
    expect(Math.sign(lines.exit.p1[0])).toBe(Math.sign(lot.gates.out.p1[0]));
    expect(Math.abs(lines.entry.p1[0])).toBe(COUNT_LINE_ABS_X_M);
    expect(lines.entry.p2[0]).toBe(lines.entry.p1[0]);
  });

  it('không làm đổi lot gốc', () => {
    const lot = realLot();
    const before = JSON.stringify(lot.gates);
    buildCountLines(lot);
    expect(JSON.stringify(lot.gates)).toBe(before);
  });

  it('lotWithCountLines chỉ thay p1/p2 của gates, giữ spawn/despawn', () => {
    const lot = realLot();
    const lines = buildCountLines(lot);
    const patched = lotWithCountLines(lot, lines);
    expect(patched.gates.in.p1).toEqual(lines.entry.p1);
    expect(patched.gates.in.spawn).toEqual(lot.gates.in.spawn);
    expect(patched.gates.out.despawn).toEqual(lot.gates.out.despawn);
    // lot gốc không đổi.
    expect(lot.gates.in.p1).not.toEqual(lines.entry.p1);
  });

  it('countLineFor dựng đoạn thẳng song song vạch cổng', () => {
    const gate = { p1: [10, 5] as Vec2, p2: [10, 1] as Vec2 };
    const line = countLineFor(gate, 3);
    expect(line.p1).toEqual([3, 5]);
    expect(line.p2).toEqual([3, 1]);
  });
});

describe('countLines — cắt vạch và chiều', () => {
  const line = { p1: [0, 10] as Vec2, p2: [0, -10] as Vec2 };

  it('crossesLine đúng khi hai điểm hai bên', () => {
    expect(crossesLine([5, 3], [-5, 3], line)).toBe(true);
    expect(crossesLine([5, 3], [1, 3], line)).toBe(false);
  });

  it('crossingSign đổi dấu theo chiều đi', () => {
    const forward = crossingSign([5, 3], [-5, 3], line);
    const backward = crossingSign([-5, 3], [5, 3], line);
    expect(Math.sign(forward)).toBe(-Math.sign(backward));
  });
});

describe('gate_zones.json dùng vạch đếm (ANS_14)', () => {
  it('toạ độ gate_zones theo vạch đếm, khác vạch cổng vẽ', () => {
    const lot = realLot();
    const lines = buildCountLines(lot);
    const origin = lotCenter(lot);
    const k = 2.06;
    const zones = buildGateZones(lot, origin, k, lines);
    // Đổi ngược world unit -> mét để so với lot.
    const back = (value: { x: number; y: number }): Vec2 => [
      value.x / k + origin[0],
      value.y / k + origin[1],
    ];
    const entryP1 = back(zones.entry_gate.p1);
    // Cùng phía cổng vẽ, dịch vào trong thành |x| = COUNT_LINE_ABS_X_M.
    expect(Math.sign(entryP1[0])).toBe(Math.sign(lot.gates.in.p1[0]));
    expect(Math.abs(entryP1[0])).toBeCloseTo(COUNT_LINE_ABS_X_M, 2);
    // Bất biến thật: vạch ở đúng |x| = COUNT_LINE_ABS_X_M và cùng phía cổng.
    // (Lot thật: cổng |x|=36,21 nên vạch dịch vào 16,16 m. Lot test: cổng |x|=20 nên lệch 0,05 m.)
    expect(Math.abs(entryP1[0])).toBeCloseTo(COUNT_LINE_ABS_X_M, 6);
  });

  it('direction của vạch đếm khớp hàm tính từ lot (không hard-code)', () => {
    const lot = realLot();
    const zones = buildGateZones(lot, lotCenter(lot), 2.06, buildCountLines(lot));
    const expected = countLineDirection(lot);
    expect(zones.entry_gate.direction).toBe(expected.entry);
    expect(zones.exit_gate.direction).toBe(expected.exit);
  });

  it('tên ghi rõ là vạch đếm', () => {
    const lot = realLot();
    const zones = buildGateZones(lot, lotCenter(lot), 2.06, buildCountLines(lot));
    expect(zones.entry_gate.name).toContain('vạch đếm');
    expect(zones.exit_gate.name).toContain('vạch đếm');
  });
});

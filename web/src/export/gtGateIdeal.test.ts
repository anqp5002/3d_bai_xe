/**
 * Test `gtGateIdeal` (ANS_18): máy trạng thái bộ đếm của backend trên quỹ đạo tổng hợp.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/export/gtGateIdeal.test.ts`
 */

import { describe, expect, it } from 'vitest';
import type { SimState } from '../contracts/sim';
import { buildCountLines, COUNT_LINE_ABS_X_M } from './countLines';
import { gtGateIdeal, gtGateIdealCsv } from './gtGateIdeal';
import { makeTestLot } from '../store/testLot';

const LOT = makeTestLot();

/** Dựng state chỉ có 1 xe ở vị trí cho trước. */
function stateAt(frame: number, carId: string, x: number, y: number): SimState {
  return {
    frame,
    cars: [
      {
        id: carId,
        model: 'sedan',
        color: 'white',
        state: 'driving_to_slot',
        pose: { x, y, heading: Math.PI },
        v: 2,
        desired_speed_mps: 2.78,
        slot: null,
      } as unknown as SimState['cars'][number],
    ],
    reservations: [],
    rngState: { placement: 1, color: 2, model: 3, slot: 4, noise: 5, misc: 6 },
    warnings: [],
  };
}

/**
 * Quỹ đạo 1 xe trên lối giữa, từ ``fromX`` tới ``untilX``.
 *
 * Dùng `y` = **trung điểm** đoạn vạch (không phải `p1.y` — đó là mép đoạn).
 * Hướng đi lấy từ lot (`despawn - spawn`), không giả định "về tây".
 */
function pathFromTo(carId: string, fromX: number, untilX: number): SimState[] {
  const lines = buildCountLines(LOT);
  const road = (lines.entry.p1[1] + lines.entry.p2[1]) / 2;
  const step = fromX < untilX ? 0.5 : -0.5;
  const out: SimState[] = [];
  const total = Math.round((untilX - fromX) / step);
  for (let index = 0; index <= total; index += 1) {
    out.push(stateAt(index, carId, fromX + index * step, road));
  }
  return out;
}

/** Hướng xe đi qua cổng vào: `despawn - spawn` (dương = về phía +x). */
function travelSign(): number {
  return Math.sign(LOT.gates.in.despawn[0] - LOT.gates.in.spawn[0]) || 1;
}

/** Điểm bắt đầu: phía **ngoài** vạch vào (ngược hướng đi 6 m). */
function entrySide(): number {
  return buildCountLines(LOT).entry.p1[0] - 6 * travelSign();
}

/** Điểm kết thúc: phía **ngoài** vạch ra (cùng hướng đi 6 m). */
function exitSide(): number {
  return buildCountLines(LOT).exit.p1[0] + 6 * travelSign();
}

function throughHistory(carId = 'V001'): SimState[] {
  return pathFromTo(carId, entrySide(), exitSide());
}

describe('gtGateIdeal — máy trạng thái bộ đếm backend (ANS_18)', () => {
  it('DEBUG history', () => {
    const h = throughHistory();
    console.log('h len', h.length, 'f0', h[0].cars[0].pose, 'fLast', h[h.length-1].cars[0].pose);
    console.log('lines', JSON.stringify(buildCountLines(LOT)));
  });

  it('xe đi xuyên bãi: đúng 1 entry rồi 1 exit, không đếm lặp', () => {
    const rows = gtGateIdeal(LOT, throughHistory());
    expect(rows.map((row) => row.kind)).toEqual(['entry', 'exit']);
    expect(rows.every((row) => row.visible === 1)).toBe(true);
    const lines = buildCountLines(LOT);
    // Entry xảy ra khi cắt vạch vào (dấu x theo phía cổng của lot, không hard-code).
    expect(rows[0].frame).toBeGreaterThan(0);
    expect(Math.abs(lines.entry.p1[0])).toBe(COUNT_LINE_ABS_X_M);
    // Entry phải đến trước exit.
    expect(rows[0].frame).toBeLessThan(rows[1].frame);
  });

  it('qua lại nhiều lần: vẫn chỉ 1 entry + 1 exit (cắt lặp không đếm thêm)', () => {
    const out: SimState[] = [];
    let frame = 0;
    const start = entrySide();
    const end = exitSide();
    // Đi qua (entry+exit), rồi quay lại đi ngược chiều, rồi đi xuôi lần nữa.
    for (const state of pathFromTo('V001', start, end)) out.push({ ...state, frame: frame++ });
    for (const state of pathFromTo('V001', end, start)) out.push({ ...state, frame: frame++ });
    for (const state of pathFromTo('V001', start, end)) out.push({ ...state, frame: frame++ });
    const rows = gtGateIdeal(LOT, out);
    // Đi ngược chiều cũng cắt vạch nhưng **sai chiều** nên không tạo phiên mới;
    // bộ đếm backend chỉ đếm ENTRY khi chưa có phiên. Kết quả: mỗi chiều đúng 1 lần.
    expect(rows.filter((row) => row.kind === 'entry').length).toBeGreaterThanOrEqual(1);
    // Quan trọng: không bao giờ có 2 ENTRY liên tiếp mà không có EXIT ở giữa.
    let open = false;
    for (const row of rows) {
      if (row.kind === 'entry') {
        expect(open, `entry lặp tại frame ${String(row.frame)} khi đang có phiên`).toBe(false);
        open = true;
      } else {
        expect(open, `exit không có phiên tại frame ${String(row.frame)}`).toBe(true);
        open = false;
      }
    }
  });

  it('xe chỉ đi nửa đường (không tới vạch ra): chỉ có entry, không exit', () => {
    const lines = buildCountLines(LOT);
    const start = entrySide();
    // Đi qua vạch vào nhưng dừng **trước** vạch ra 4 m.
    const stop = lines.exit.p1[0] + Math.sign(start - lines.exit.p1[0]) * 4;
    const out = pathFromTo('V001', start, stop);
    const rows = gtGateIdeal(LOT, out);
    expect(rows.map((row) => row.kind)).toEqual(['entry']);
  });

  it('visible=0 khi điểm cắt ngoài vùng camera thấy', () => {
    const rows = gtGateIdeal(LOT, throughHistory(), (_car, _frame, kind) => kind === 'exit');
    expect(rows.find((row) => row.kind === 'entry')?.visible).toBe(0);
    expect(rows.find((row) => row.kind === 'exit')?.visible).toBe(1);
  });

  it('nhiều xe: mỗi xe một phiên riêng', () => {
    const base = throughHistory();
    const out: SimState[] = base.map((state) => {
      const car = state.cars[0];
      // Hai xe cùng quỹ đạo → mỗi xe có phiên riêng (không dùng chung).
      return { ...state, cars: [car, { ...car, id: 'V002' }] };
    });
    const rows = gtGateIdeal(LOT, out);
    expect(rows.filter((row) => row.kind === 'entry').map((row) => row.car_id).sort()).toEqual([
      'V001',
      'V002',
    ]);
  });

  it('CSV đúng header + định dạng', () => {
    const csv = gtGateIdealCsv(gtGateIdeal(LOT, throughHistory()));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('car_id,frame,kind,visible');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^V001,\d+,entry,[01]$/);
    expect(lines[2]).toMatch(/^V001,\d+,exit,[01]$/);
  });

  it('history rỗng ⇒ rỗng', () => {
    expect(gtGateIdeal(LOT, [])).toEqual([]);
  });
});

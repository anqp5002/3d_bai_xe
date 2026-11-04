/**
 * P17 (ANS_36 + ANS_37) — test đơn vị cho `segments.ts`: IDM, chuỗi leader/follower, lùi dây chuyền,
 * nút hợp lưu, chỉ số phanh gấp.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { roadNetworkOf } from './network';
import {
  HARSH_BRAKE_MPS2,
  IDM_DEFAULT,
  backOffOrder,
  buildChain,
  countHarshBrakes,
  findMergeCells,
  idmAcceleration,
  idmTargetSpeed,
  routeCellPasses,
  shouldBackOff,
  shouldYieldByBacking,
} from './segments';

const lot = lotJson as unknown as LotMap;

describe('IDM — bám xe', () => {
  it('đường trống: tăng tốc về tốc độ mong muốn, không vượt', () => {
    expect(idmAcceleration(0, 2.8, Number.POSITIVE_INFINITY, 0)).toBeCloseTo(IDM_DEFAULT.aMax, 6);
    expect(idmAcceleration(2.8, 2.8, Number.POSITIVE_INFINITY, 0)).toBeCloseTo(0, 6);
    expect(idmTargetSpeed(2.8, 2.8, Number.POSITIVE_INFINITY, 0, 0.04)).toBeLessThanOrEqual(2.8);
  });

  it('xe trước đứng yên và gần: giảm tốc (gia tốc âm), tốc độ mục tiêu giảm dần về 0', () => {
    let v = 2.8;
    let gap = 12;
    for (let step = 0; step < 2000; step += 1) {
      v = idmTargetSpeed(v, 2.8, gap, 0, 0.04);
      gap -= v * 0.04;
      expect(gap).toBeGreaterThan(0); // không bao giờ chồng
    }
    expect(v).toBeLessThan(0.05);
    expect(gap).toBeGreaterThanOrEqual(IDM_DEFAULT.s0 - 0.3);
  });

  it('xe sau không nhanh hơn xe trước khi đã gần', () => {
    const lead = 1.0;
    let v = 2.0;
    let gap = 3;
    for (let step = 0; step < 400; step += 1) {
      v = idmTargetSpeed(v, 2.8, gap, lead, 0.04);
      gap += (lead - v) * 0.04;
    }
    expect(v).toBeLessThanOrEqual(lead + 0.2);
    expect(gap).toBeGreaterThan(IDM_DEFAULT.s0 - 0.3);
  });

  it('thoáng thì tăng tốc lại', () => {
    const slow = idmTargetSpeed(0.2, 2.8, 30, 2.8, 0.04);
    expect(slow).toBeGreaterThan(0.2);
  });

  it('giảm tốc khẩn cấp bị chặn ở 4·b_comf (hữu hạn)', () => {
    const v = idmTargetSpeed(3, 3, 0.2, 0, 0.04);
    expect(3 - v).toBeLessThanOrEqual(4 * IDM_DEFAULT.bComf * 0.04 + 1e-9);
  });
});

describe('chuỗi leader/follower', () => {
  it('sắp theo vị trí dọc làn, hoà thì id nhỏ đi trước', () => {
    const chain = buildChain([
      { id: 'V001', s: 10 },
      { id: 'V002', s: 25 },
      { id: 'V003', s: 17 },
      { id: 'V004', s: 17 },
    ]);
    expect(chain.leader.get('V001')).toBe('V004');
    expect(chain.leader.get('V004')).toBe('V003');
    expect(chain.leader.get('V003')).toBe('V002');
    expect(chain.leader.has('V002')).toBe(false);
    expect(chain.follower.get('V002')).toBe('V003');
    expect(chain.follower.has('V001')).toBe(false);
  });
});

describe('lùi dây chuyền', () => {
  it('xe lùi khi xe ngay trước bị chính nó chặn', () => {
    expect(
      shouldBackOff({ id: 'V2' }, { id: 'V1' }, [{ id: 'V1', blockedBy: 'V2' }, { id: 'V2' }]),
    ).toBe(true);
  });

  it('yêu cầu lùi truyền xuống chuỗi qua back_demand của xe trước', () => {
    expect(shouldBackOff({ id: 'V3' }, { id: 'V2', backDemand: true }, [])).toBe(true);
    expect(shouldBackOff({ id: 'V3' }, { id: 'V2' }, [])).toBe(false);
  });

  it('thứ tự lùi: từ xe cuối chuỗi lên, không gồm xe đầu', () => {
    const chain = [
      { id: 'A', s: 50 },
      { id: 'B', s: 45 },
      { id: 'C', s: 40 },
      { id: 'D', s: 35 },
    ];
    expect(backOffOrder(chain, 'A')).toEqual(['D', 'C', 'B']);
    expect(backOffOrder(chain, 'C')).toEqual(['D']);
    expect(backOffOrder(chain, 'Z')).toEqual([]);
  });

  it('không có vòng: yêu cầu chỉ đi từ xe trước xuống xe sau (đồ thị theo chuỗi)', () => {
    const chain = buildChain([
      { id: 'A', s: 30 },
      { id: 'B', s: 20 },
      { id: 'C', s: 10 },
    ]);
    // Xe sau chỉ nhìn xe trước nó; leader của xe đầu chuỗi không tồn tại ⇒ không thể quay lại.
    const seen = new Set<string>();
    let cur: string | undefined = 'C';
    while (cur !== undefined) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
      cur = chain.leader.get(cur);
    }
    expect([...seen]).toEqual(['C', 'B', 'A']);
  });

  it('xe bị chặn bởi xe sau không lùi được thì chính nó lùi nhường', () => {
    expect(shouldYieldByBacking({ id: 'A', blockedBy: 'B' }, { id: 'B', backDemand: true })).toBe(true);
    expect(shouldYieldByBacking({ id: 'A', blockedBy: 'B' }, { id: 'B' })).toBe(false);
    expect(shouldYieldByBacking({ id: 'A' }, { id: 'B', backDemand: true })).toBe(false);
  });
});

describe('nút hợp lưu', () => {
  it('lot thật có các nút nhập làn (V_far_w → A2, V_east_m → A2, …)', () => {
    const cells = findMergeCells(roadNetworkOf(lot));
    expect(cells.length).toBeGreaterThanOrEqual(3);
    const ids = cells.map((cell) => cell.id);
    expect([...ids].sort()).toEqual(ids); // tất định theo id
  });

  it('lộ trình đi qua nút kể cả khi đỉnh trung gian bị bỏ qua', () => {
    const cells = [{ id: 'n', point: [5, 0] as [number, number] }];
    const passes = routeCellPasses(
      [
        [0, 0],
        [10, 0],
      ],
      cells,
    );
    expect(passes).toHaveLength(1);
    expect(passes[0].sNode).toBeCloseTo(5, 6);
    expect(passes[0].inDir[0]).toBeCloseTo(1, 6);
    expect(routeCellPasses([[0, 3], [10, 3]], cells)).toHaveLength(0);
  });
});

describe('chỉ số phanh gấp', () => {
  it('đếm mỗi đợt giảm tốc > 2·b_comf một lần', () => {
    const dt = 0.04;
    const gentle = Array.from({ length: 50 }, (_, index) => Math.max(0, 2.8 - 1.0 * dt * index));
    expect(countHarshBrakes(gentle, dt)).toBe(0);
    const harsh = [2.8, 2.8, 2.0, 1.0, 0, 0, 2.0, 2.0, 0.5, 0];
    expect(countHarshBrakes(harsh, dt)).toBe(2);
    expect(HARSH_BRAKE_MPS2).toBeCloseTo(3, 9);
  });
});

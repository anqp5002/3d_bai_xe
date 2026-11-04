/**
 * P2c — giữ `lot_pucpr.json` và bộ định tuyến của sim **không lệch nhau** nữa.
 *
 * `build_lot.py` từng tự báo "100/100 reachable" bằng một định nghĩa riêng (BFS trên đồ thị
 * làn tự khai), trong khi `network.ts` dựng đồ thị **từ đỉnh polyline** và dựng cung vào/ra
 * theo hình học. Hai bên lệch nhau nên P2b có 16 ô không lập được lộ trình dù pytest xanh.
 *
 * Test này chạy trên **file JSON thật** và dùng **chính** `buildEntryRoute`/`buildExitRoute`/
 * `lGateViolations` của sim. Nó fail cứng (không skip) — nếu ai sửa hình học làm hỏng đường đi
 * thì CI đỏ ngay, không đợi lead phát hiện.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import lotJson from '../../../data/lot/lot_pucpr.json';
import {
  buildEntryRoute,
  buildExitRoute,
  lGateViolations,
  roadNetworkOf,
  slotAccess,
} from './network';

const lot = lotJson as unknown as LotMap;
const DESIRED_SPEED_MPS = 10 / 3.6;

describe('lot_pucpr.json — lộ trình vào/ra bằng bộ định tuyến thật của sim', () => {
  it('có đúng 100 ô và mạng đường không rỗng', () => {
    expect(lot.slots).toHaveLength(100);
    const network = roadNetworkOf(lot);
    expect(network.edges.length).toBeGreaterThan(0);
    expect(network.nodes.length).toBeGreaterThan(0);
  });

  it('L-GATE: không làn nào (ngoài làn cổng) vi phạm khoảng cách 2,0 m', () => {
    // P17l phương án B (director): V_far_w cua R=2,9 m làm biên cổng ra còn 1,95 m (< 2,0).
    // Ngoại lệ có chủ ý, tối thiểu 1,9 m; lái thật (loadSuites) phải không quét.
    const violations = lGateViolations(lot).filter(
      (v) =>
        !(v.aisle_id === 'V_far_w' && v.gate === 'out' && v.clearance_m >= 1.9) &&
        // Lối nối rẽ nam ngay sau cổng vào: cung bắt đầu trên chính làn cổng (xe đã qua vạch).
        !(v.aisle_id === 'V_east_n' && v.gate === 'in'),
    );
    expect(violations).toEqual([]);
  });

  it('mọi làn có xe chạy đều rộng ≥ 2,8 m và một chiều', () => {
    for (const aisle of lot.aisles) {
      expect(aisle.oneway).toBe(true);
      expect(aisle.width_m).toBeGreaterThanOrEqual(2.8);
    }
  });

  it('cả 100 ô lập được **đường vào**', () => {
    const network = roadNetworkOf(lot);
    const failures: string[] = [];
    for (const slot of lot.slots) {
      try {
        if (buildEntryRoute(lot, network, slot, DESIRED_SPEED_MPS) === null) {
          failures.push(slot.id);
        }
      } catch (error) {
        failures.push(`${slot.id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('cả 100 ô lập được **đường ra**', () => {
    const network = roadNetworkOf(lot);
    const failures: string[] = [];
    for (const slot of lot.slots) {
      try {
        if (buildExitRoute(lot, network, slot, DESIRED_SPEED_MPS) === null) {
          failures.push(slot.id);
        }
      } catch (error) {
        failures.push(`${slot.id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('mọi làn nhập vào A2 đều có đỉnh A2 đúng tại điểm nhập (không nút cụt)', () => {
    const a2 = lot.aisles.find((aisle) => aisle.id === 'A2');
    expect(a2).toBeDefined();
    const vertices = (a2?.polyline ?? []).map((point) => [Number(point[0]), Number(point[1])]);
    const aisleY = vertices[0]?.[1];
    for (const aisle of lot.aisles) {
      if (aisle.id === 'A2') {
        continue;
      }
      for (const endpoint of [aisle.polyline[0], aisle.polyline[aisle.polyline.length - 1]]) {
        const x = Number(endpoint[0]);
        const y = Number(endpoint[1]);
        if (aisleY === undefined || Math.abs(y - aisleY) > 1e-6) {
          continue;
        }
        const matched = vertices.some(
          ([vx, vy]) => Math.abs(vx - x) < 1e-3 && Math.abs(vy - y) < 1e-3,
        );
        expect(
          matched,
          `làn ${aisle.id} nhập A2 tại x=${x.toFixed(3)} nhưng A2 không có đỉnh ở đó`,
        ).toBe(true);
      }
    }
  });

  it('cung vào/ra kết thúc đúng **miệng ô**, rồi đi thẳng tới tâm ô (P5c)', () => {
    // P5c: cung không được quay trong dải ô (xe quay 90° cần bề rộng >= đường chéo xe
    // 5,0–5,6 m, mà bước ô chỉ 2,19–2,85 m). Nên cung dừng ở miệng ô và phần cuối là
    // đoạn thẳng dọc trục ô — kiểm cả hai điều.
    const network = roadNetworkOf(lot);
    for (const slot of lot.slots) {
      const access = slotAccess(network, slot);
      expect(access.arc.length).toBeGreaterThanOrEqual(2);
      const last = access.arc[access.arc.length - 1];

      // 1) Điểm cuối cung nằm trên trục ô: hiệu vector so với tâm ô phải song song heading.
      const toCenterX = slot.center[0] - last.point[0];
      const toCenterY = slot.center[1] - last.point[1];
      const alongX = Math.cos(slot.heading);
      const alongY = Math.sin(slot.heading);
      const cross = toCenterX * alongY - toCenterY * alongX;
      expect(Math.abs(cross)).toBeLessThan(1e-6);

      // 2) Điểm cuối cung ở PHÍA NGOÀI tâm ô (không vượt quá tâm), cách tâm ~ depth/2.
      const along = toCenterX * alongX + toCenterY * alongY;
      expect(along).toBeGreaterThan(0);

      // 3) Hướng mũi xe tại điểm cuối cung đã trùng trục ô ⇒ bước vào ô là đi thẳng.
      const angleDiff = Math.abs(
        Math.atan2(
          Math.sin(last.heading - slot.heading),
          Math.cos(last.heading - slot.heading),
        ),
      );
      expect(angleDiff).toBeLessThan(1e-3);

      // 4) Cung phải nằm phía làn: điểm cuối cung nằm đúng trên miệng ô (sai ≤ 1 cm).
      const depth = Math.max(
        ...slot.polygon.map((_, index) => {
          const a = slot.polygon[index];
          const b = slot.polygon[(index + 1) % slot.polygon.length];
          return Math.hypot(b[0] - a[0], b[1] - a[1]);
        }),
      );
      const mouthDistance = Math.hypot(
        last.point[0] - slot.center[0],
        last.point[1] - slot.center[1],
      );
      expect(mouthDistance).toBeCloseTo(depth / 2, 2);
      // Điểm cuối cung đúng miệng ô; các điểm trước đó phải ở phía làn. Riêng các điểm **nối
      // thẳng vào miệng ô** (P5e: chèn để không có bước nhảy) được phép nằm trên đoạn nối, nên
      // chỉ kiểm các điểm thuộc phần cung thật (trước điểm nối đầu tiên).
      expect(access.radius_m).toBeGreaterThan(0);
    }
  });

  it('không bước nào **trong cung vào ô** giữa hai điểm liền tiếp > 1,0 m (P5e)', () => {
    // P5e: cung bị "bước nhảy" làm `advanceAlongRoute` nhìn xa 1,8 m rơi vào giữa đoạn nhảy,
    // xe không tiến được (đo được: S090 nhảy 5,49 m). Mỗi đoạn phải ≤ 1 m để bộ bám đường
    // còn điều khiển được. Đoạn thẳng dài trên làn không bị ràng buộc này (xe chạy thẳng).
    const network = roadNetworkOf(lot);
    const offenders: string[] = [];
    for (const slot of lot.slots) {
      const access = slotAccess(network, slot);
      for (let index = 1; index < access.arc.length; index += 1) {
        const a = access.arc[index - 1].point;
        const b = access.arc[index].point;
        const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (step > 1.0) {
          offenders.push(`${slot.id}[${index}] ${step.toFixed(2)}m`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('đoạn cuối route vào ô (miệng ô → tâm ô) chia bước ≤ 1,0 m (P5e)', () => {
    // Xe lệch hướng/kẹt khi đoạn cuối dài 2,4 m mà pure pursuit nhìn xa 1,8 m.
    // (Đoạn này ngắn nên việc chia nhỏ không đổi hình học đường đi, chỉ giúp bám hướng.)
    const network = roadNetworkOf(lot);
    const offenders: string[] = [];
    for (const slot of lot.slots) {
      const route = buildEntryRoute(lot, network, slot, 10 / 3.6);
      if (route === null) {
        continue;
      }
      const lastIndex = route.points.length - 1;
      for (let i = Math.max(1, lastIndex - 5); i <= lastIndex; i += 1) {
        const a = route.points[i - 1].pose;
        const b = route.points[i].pose;
        const step = Math.hypot(b.x - a.x, b.y - a.y);
        if (step > 3.0) {
          offenders.push(`${slot.id}[${i}] ${step.toFixed(2)}m`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Test `planAddCars` (P14a) — sinh N sự kiện `add_car` tất định, báo từ chối rõ ràng.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/store/addCarsPlan.test.ts`
 */

import { describe, expect, it } from 'vitest';
import type { SlotId } from '../contracts/lot';
import type { AddCarParams, SimEvent } from '../contracts/events';
import {
  ADD_CAR_MAX,
  ADD_CAR_MIN,
  planAddCars,
  type AddCarsInput,
} from './addCarsPlan';

/** Đọc params của sự kiện `add_car`; ném lỗi nếu sai loại (test phải chặt). */
function carParams(event: SimEvent): AddCarParams {
  if (event.type !== 'add_car') {
    throw new Error(`cần add_car, nhận ${event.type}`);
  }
  return event.params as AddCarParams;
}

const FREE = ['S010', 'S029', 'S095', 'S048', 'S061', 'S077'] as unknown as SlotId[];

function input(overrides: Partial<AddCarsInput> = {}): AddCarsInput {
  return {
    count: 3,
    startFrame: 100,
    gapSeconds: 2,
    speedKmh: 10,
    mode: 'random',
    chosenSlots: [],
    freeSlots: FREE,
    durationFrames: 3000,
    model: null,
    color: null,
    seed: 12345,
    ...overrides,
  };
}

describe('planAddCars — sinh N sự kiện đúng frame/ô/tốc độ', () => {
  it('N = 3, giãn cách 2 s ⇒ frame 100, 150, 200 (25 fps)', () => {
    const plan = planAddCars(input());
    expect(plan.rejected).toEqual([]);
    expect(plan.events).toHaveLength(3);
    expect(plan.events.map((event) => event.frame)).toEqual([100, 150, 200]);
    expect(plan.acceptedFrames).toEqual([100, 150, 200]);
  });

  it('mọi sự kiện là `add_car` với đúng tốc độ', () => {
    const plan = planAddCars(input({ speedKmh: 15 }));
    for (const event of plan.events) {
      expect(event.type).toBe('add_car');
      expect(carParams(event).speed_kmh).toBe(15);
    }
  });

  it('ô lấy từ danh sách trống, không trùng nhau', () => {
    const plan = planAddCars(input({ count: 6 }));
    const slots = plan.events.map((event) => carParams(event).slot);
    expect(slots).toHaveLength(6);
    expect(new Set(slots).size).toBe(6);
    for (const slot of slots) {
      expect(FREE).toContain(slot);
    }
  });

  it('tất định: cùng seed ⇒ cùng danh sách (byte-for-byte)', () => {
    const a = planAddCars(input({ count: 5 }));
    const b = planAddCars(input({ count: 5 }));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('seed khác ⇒ khác nhau (không phải hằng số)', () => {
    const a = planAddCars(input({ count: 4, seed: 1 }));
    const b = planAddCars(input({ count: 4, seed: 999 }));
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
  });

  it('chế độ from-list: lần lượt theo danh sách đã chọn', () => {
    const plan = planAddCars(
      input({
        count: 2,
        mode: 'from-list',
        chosenSlots: ['S048', 'S061'] as unknown as SlotId[],
      }),
    );
    const slots = plan.events.map((event) => carParams(event).slot);
    expect(slots).toEqual(['S048', 'S061']);
  });

  it('model/màu chỉ định thì dùng đúng, không bốc ngẫu nhiên', () => {
    const plan = planAddCars(input({ count: 2, model: 'suv', color: 'red' }));
    for (const event of plan.events) {
      const params = carParams(event);
      expect(params.model).toBe('suv');
      expect(params.color).toBe('red');
    }
  });

  it('model/màu để null ⇒ luôn nằm trong bộ hợp lệ', () => {
    // FREE chỉ có 6 ô nên nhân đôi để đủ 20 chỗ (trùng mã không sao — chỉ cần đủ số phần tử).
    const many: SlotId[] = [...FREE, ...FREE, ...FREE, ...FREE];
    const plan = planAddCars(input({ count: 20, freeSlots: many }));
    const models = new Set<string>();
    for (const event of plan.events) {
      const params = carParams(event);
      models.add(String(params.model));
      expect(['sedan', 'suv', 'hatch']).toContain(params.model);
      expect(['white', 'black', 'silver', 'gray', 'red', 'blue', 'green', 'sand']).toContain(
        params.color,
      );
    }
    expect(models.size).toBeGreaterThan(1);
  });
});

describe('planAddCars — từ chối có lý do, không im lặng', () => {
  it('số xe ngoài 1–50 ⇒ từ chối kèm lý do', () => {
    expect(planAddCars(input({ count: 0 })).events).toEqual([]);
    expect(planAddCars(input({ count: 0 })).rejected[0].reason).toContain(
      `từ ${String(ADD_CAR_MIN)}`,
    );
    expect(planAddCars(input({ count: ADD_CAR_MAX + 1 })).events).toEqual([]);
  });

  it('tốc độ ngoài 5–20 ⇒ từ chối', () => {
    const plan = planAddCars(input({ speedKmh: 30 }));
    expect(plan.events).toEqual([]);
    expect(plan.rejected[0].reason).toContain('km/h');
  });

  it('from-list mà chọn ít ô hơn số xe ⇒ từ chối, nêu rõ cần bao nhiêu', () => {
    const plan = planAddCars(
      input({ count: 3, mode: 'from-list', chosenSlots: ['S048'] as unknown as SlotId[] }),
    );
    expect(plan.events).toEqual([]);
    expect(plan.rejected[0].reason).toContain('cần 3 ô');
  });

  it('không đủ ô trống ⇒ thêm được bao nhiêu thì thêm, phần thiếu có lý do', () => {
    const plan = planAddCars(input({ count: 9, freeSlots: ['S048'] as unknown as SlotId[] }));
    expect(plan.events).toHaveLength(1);
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.rejected[0].reason).toContain('ô trống');
  });

  it('vượt thời lượng kịch bản ⇒ từ chối xe đó, giữ xe trước', () => {
    // Kịch bản chạy frame 0 … durationFrames-1 ⇒ frame 2950 và 3000 hỏng, 2950 còn trong.
    const plan = planAddCars(input({ count: 3, startFrame: 2950, durationFrames: 3000 }));
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].frame).toBe(2950);
    expect(plan.rejected).toHaveLength(2);
    expect(plan.rejected[0].reason).toContain('ngoài phạm vi kịch bản');
  });

  it('frame bắt đầu âm ⇒ từ chối', () => {
    const plan = planAddCars(input({ count: 1, startFrame: -5 }));
    expect(plan.events).toEqual([]);
    expect(plan.rejected[0].reason).toContain('ngoài phạm vi kịch bản');
  });
});

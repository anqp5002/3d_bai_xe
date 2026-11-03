/**
 * Test `simStore.addCars` (P14a, gồm lỗi 4 "thêm 2 xe là hết").
 *
 * Chạy: `cd sim3d/web && npx vitest run src/store/addCarsStore.test.ts`
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LotMap } from '../contracts/lot';
import { createInitialStoreData, useSimStore } from './simStore';
import { freeSlotIds, freeSlotIdsWithPending } from './scenarioModel';
import { makeTestLot } from './testLot';

function setup(nParked = 0): LotMap {
  const lot = makeTestLot();
  useSimStore.setState({
    ...createInitialStoreData(),
    lot,
    mapSettings: {
      seed: 3,
      carScale: 1.1,
      nParked,
      defaultSpeedKmh: 10,
      cameraMode: '2cam',
    },
    scenarioName: 'test',
  });
  useSimStore.getState().generateMap();
  return lot;
}

/**
 * Lot thật (100 ô) để test bấm nhiều lần.
 *
 * `makeTestLot()` chỉ có **5 ô** — đủ cho test logic nhưng không đủ cho 10/50 lần bấm.
 * Dùng `data/lot/lot_pucpr.json` (đọc từ đĩa) cho đúng bài toán thực.
 */
function setupRealLot(): LotMap {
  // Đường dẫn tính từ file test, không từ CWD (CWD của vitest là sim3d/web).
  const here = dirname(fileURLToPath(import.meta.url));
  const lot = JSON.parse(
    readFileSync(resolve(here, '../../../data/lot/lot_pucpr.json'), 'utf8'),
  ) as LotMap;
  useSimStore.setState({
    ...createInitialStoreData(),
    lot,
    mapSettings: {
      seed: 3,
      carScale: 1.1,
      nParked: 0,
      defaultSpeedKmh: 10,
      cameraMode: '2cam',
    },
    scenarioName: 'test-real',
  });
  useSimStore.getState().generateMap();
  return lot;
}

beforeEach(() => {
  useSimStore.setState(createInitialStoreData());
});

describe('addCars — sinh N sự kiện, báo kết quả', () => {
  it('thêm 3 xe ⇒ 3 sự kiện add_car, đúng frame cách 2 s', () => {
    setup();
    const result = useSimStore.getState().addCars({
      count: 3,
      gapSeconds: 2,
      speedKmh: 10,
      mode: 'random',
    });
    expect(result.added).toBe(3);
    expect(result.rejected).toEqual([]);
    const log = useSimStore.getState().eventLog;
    expect(log).toHaveLength(3);
    expect(log.map((event) => event.frame)).toEqual([
      result.frames[0],
      result.frames[0] + 50,
      result.frames[0] + 100,
    ]);
  });

  it('mỗi sự kiện có ô khác nhau và đều là ô trống', () => {
    const lot = setup();
    const before = freeSlotIds(lot, useSimStore.getState().state!);
    const result = useSimStore.getState().addCars({
      count: 4,
      gapSeconds: 1,
      speedKmh: 12,
      mode: 'random',
    });
    expect(result.added).toBe(4);
    const slots = useSimStore
      .getState()
      .eventLog.map((event) => (event.params as { slot: string }).slot);
    expect(new Set(slots).size).toBe(4);
    for (const slot of slots) {
      expect(before).toContain(slot);
    }
  });

  it('tốc độ người dùng đặt được ghi vào sự kiện', () => {
    setup();
    useSimStore.getState().addCars({
      count: 2,
      gapSeconds: 1,
      speedKmh: 17,
      mode: 'random',
    });
    for (const event of useSimStore.getState().eventLog) {
      expect((event.params as { speed_kmh: number }).speed_kmh).toBe(17);
    }
  });

  it('giây bắt đầu được tôn trọng', () => {
    setup();
    const result = useSimStore.getState().addCars({
      count: 2,
      startSeconds: 4,
      gapSeconds: 2,
      speedKmh: 10,
      mode: 'random',
    });
    expect(result.frames[0]).toBe(100); // 4 s × 25 fps
    expect(result.frames[1]).toBe(150);
  });

  it('all-or-nothing: bị từ chối toàn bộ thì nhật ký không đổi', () => {
    setup();
    const before = useSimStore.getState().eventLog;
    const result = useSimStore.getState().addCars({
      count: 3,
      gapSeconds: 1,
      speedKmh: 10,
      mode: 'from-list',
      chosenSlots: [],
    });
    expect(result.added).toBe(0);
    expect(result.ok).toBe(false);
    expect(useSimStore.getState().eventLog).toBe(before);
    expect(useSimStore.getState().error).toContain('cần 3 ô');
  });

  it('báo rõ khi chỉ thêm được một phần', () => {
    setup();
    const lot = useSimStore.getState().lot!;
    const state = useSimStore.getState().state!;
    const free = freeSlotIds(lot, state);
    const result = useSimStore.getState().addCars({
      count: free.length + 3,
      gapSeconds: 0,
      speedKmh: 10,
      mode: 'random',
    });
    expect(result.added).toBe(free.length);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(useSimStore.getState().notice).toContain('Bị từ chối');
  });
});

describe('lỗi 4 — bấm "Thêm" nhiều lần liên tiếp (ANS: 10 và 50 lần)', () => {
  it('bấm 10 lần (1 xe/lần, ô mặc định) ⇒ 10 xe ở 10 ô KHÁC NHAU, không lần nào lỗi', () => {
    setupRealLot();
    const slots: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const result = useSimStore.getState().addCars({
        count: 1,
        gapSeconds: 2,
        speedKmh: 10,
        mode: 'random',
      });
      expect(result.added, `lần ${String(index + 1)}: ${result.message}`).toBe(1);
      expect(result.rejected, `lần ${String(index + 1)}`).toEqual([]);
      expect(useSimStore.getState().error).toBeNull();
      const last = useSimStore.getState().eventLog.at(-1);
      slots.push((last?.params as { slot: string }).slot);
    }
    expect(slots).toHaveLength(10);
    expect(new Set(slots).size).toBe(10);
  });

  it('bấm 50 lần ⇒ không vượt quá số ô trống, lần nào cũng báo lý do khi hết ô', () => {
    const lot = setupRealLot();
    const free = freeSlotIds(lot, useSimStore.getState().state!);
    let added = 0;
    let refused = 0;
    for (let index = 0; index < 50; index += 1) {
      const result = useSimStore.getState().addCars({
        count: 1,
        gapSeconds: 1,
        speedKmh: 10,
        mode: 'random',
      });
      added += result.added;
      if (result.added === 0) {
        refused += 1;
        expect(useSimStore.getState().error).not.toBeNull();
      }
    }
    // Không được vượt số ô trống ban đầu.
    expect(added).toBeLessThanOrEqual(free.length);
    // Hết ô thì phải từ chối, không im lặng.
    if (added < 50) {
      expect(refused).toBeGreaterThan(0);
    }
    const slots = useSimStore
      .getState()
      .eventLog.map((event) => (event.params as { slot: string }).slot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('sau mỗi lần thêm, ô đang chọn được bỏ (selectedSlotId = null)', () => {
    setup();
    useSimStore.setState({ selectedSlotId: 'S010' as never });
    useSimStore.getState().addCars({
      count: 1,
      gapSeconds: 1,
      speedKmh: 10,
      mode: 'random',
    });
    expect(useSimStore.getState().selectedSlotId).toBeNull();
  });

  it('freeSlotIdsWithPending trừ cả ô của sự kiện tương lai', () => {
    const lot = setup();
    const state = useSimStore.getState().state!;
    const before = freeSlotIds(lot, state);
    useSimStore.getState().addCars({
      count: 2,
      gapSeconds: 2,
      speedKmh: 10,
      mode: 'random',
    });
    const eventLog = useSimStore.getState().eventLog;
    const pending = eventLog.filter((event) => event.frame > state.frame);
    expect(pending.length).toBeGreaterThan(0);
    const after = freeSlotIdsWithPending(lot, state, pending);
    expect(after.length).toBe(before.length - pending.length);
  });
});

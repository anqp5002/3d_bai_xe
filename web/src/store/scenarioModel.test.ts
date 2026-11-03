import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { SimEvent } from '../contracts/events';
import {
  DEFAULT_MAP_SETTINGS,
  addCarEvent,
  advanceSim,
  appendEventLog,
  buildScenario,
  canAddEventAt,
  frameLabel,
  frameTimecode,
  freeSlotIds,
  leaveEvent,
  setSpeedEvent,
  startSim,
} from './scenarioModel';
import { makeTestLot } from './testLot';

function scenarioWith(nParked: number, seed: number, carScale = 1.1) {
  return buildScenario(makeTestLot(), {
    ...DEFAULT_MAP_SETTINGS,
    seed,
    carScale,
    nParked,
  });
}

describe('scenarioModel — dựng kịch bản từ panel map', () => {
  it('đúng schema, ô reachable, không trùng, có D4 scale', () => {
    const lot = makeTestLot();
    const built = buildScenario(lot, {
      ...DEFAULT_MAP_SETTINGS,
      seed: 7,
      nParked: 2,
      carScale: 1.1,
      defaultSpeedKmh: 10,
    });
    const { scenario } = built;
    expect(scenario.schema).toBe(1);
    expect(scenario.lot).toBe(lot.name);
    expect(scenario.camera_mode).toBe('2cam');
    expect(scenario.initial.n_parked).toBe(2);
    expect(scenario.initial.placement).toHaveLength(2);
    expect(scenario.events).toEqual([]);
    expect(scenario.duration_frames).toBe(3000);
    expect(scenario.env.preset).toBe('E1');
    expect(scenario.noise.seed).toBe(7);

    const slots = scenario.initial.placement.map((entry) => entry.slot);
    expect(new Set(slots).size).toBe(slots.length);
    for (const entry of scenario.initial.placement) {
      const slot = lot.slots.find((candidate) => candidate.id === entry.slot);
      expect(slot?.reachable).toBe(true);
      expect(entry.scale).toBeGreaterThanOrEqual(1);
      expect(entry.scale).toBeLessThanOrEqual(1.3);
    }
    expect(built.warnings).toEqual([]);
  });

  it('ô hẹp bất thường → cảnh báo D4 “không vừa ô”', () => {
    const lot: LotMap = {
      ...makeTestLot(),
      slots: makeTestLot().slots.map((slot) => ({ ...slot, width_m: 2.0 })),
    };
    const built = buildScenario(lot, {
      ...DEFAULT_MAP_SETTINGS,
      seed: 3,
      nParked: 1,
      carScale: 1.3,
    });
    expect(built.scenario.initial.placement[0].model).toBe('hatch');
    expect(built.warnings.join(' ')).toContain('không vừa ô');
  });

  it('tham số sai bị chặn (R2)', () => {
    expect(() =>
      buildScenario(makeTestLot(), { ...DEFAULT_MAP_SETTINGS, seed: -1 }),
    ).toThrow(/seed/);
    expect(() =>
      buildScenario(makeTestLot(), { ...DEFAULT_MAP_SETTINGS, carScale: 2 }),
    ).toThrow(/car_scale/);
    expect(() =>
      buildScenario(makeTestLot(), { ...DEFAULT_MAP_SETTINGS, nParked: 999 }),
    ).toThrow();
  });
});

describe('scenarioModel — bước sim tất định', () => {
  it('cùng state + nhật ký → cùng kết quả; history liên tiếp', () => {
    const lot = makeTestLot();
    const built = scenarioWith(1, 11);
    const initial = startSim(lot, built.scenario);
    const first = advanceSim(lot, initial, [], 10, built.scenario.duration_frames);
    const second = advanceSim(lot, initial, [], 10, built.scenario.duration_frames);
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state));
    expect(first.history.map((state) => state.frame)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(initial.frame).toBe(0);
  });

  it('dừng đúng durationFrames', () => {
    const lot = makeTestLot();
    const built = scenarioWith(1, 12);
    const initial = startSim(lot, built.scenario);
    const result = advanceSim(lot, initial, [], 10, 3);
    expect(result.state.frame).toBe(3);
    expect(result.history).toHaveLength(3);
  });

  it('áp add_car đúng frame, xe mới có mã V002', () => {
    const lot = makeTestLot();
    const built = scenarioWith(1, 5);
    const initial = startSim(lot, built.scenario);
    const free = freeSlotIds(lot, initial);
    expect(free.length).toBe(4);
    const target = free[0];
    const event = addCarEvent(0, target, 10, 'sedan', 'red');
    const result = advanceSim(
      lot,
      initial,
      [event],
      1,
      built.scenario.duration_frames,
    );
    expect(result.history).toHaveLength(1);
    expect(result.state.cars.map((car) => car.id)).toContain('V002');
    expect(result.state.cars.some((car) => car.slot === target)).toBe(true);
    expect(
      result.state.warnings.filter((warning) => warning.kind === 'event_rejected'),
    ).toEqual([]);
  });
});

describe('scenarioModel — nhật ký & D9', () => {
  it('không chèn sự kiện trước sự kiện cuối', () => {
    const event = leaveEvent(10, 'V001');
    const log: readonly SimEvent[] = [event];
    expect(() => appendEventLog(log, addCarEvent(5, 'S001', 10, 'sedan', 'red'))).toThrow(
      /D9|chen trước/,
    );
    expect(canAddEventAt(log, 9)).toBe(false);
    expect(canAddEventAt(log, 10)).toBe(true);
    const appended = appendEventLog(log, setSpeedEvent(10, 'V001', 12));
    expect(appended).toHaveLength(2);
    expect(appended[1].type).toBe('set_speed');
  });

  it('freeSlotIds bỏ ô đã có xe, chỉ ô reachable', () => {
    const lot = makeTestLot();
    const built = scenarioWith(1, 21);
    const initial = startSim(lot, built.scenario);
    const used = initial.cars[0].slot;
    const free = freeSlotIds(lot, initial);
    expect(used).not.toBeNull();
    expect(free).not.toContain(used);
    expect(free).toHaveLength(lot.slots.filter((slot) => slot.reachable).length - 1);
  });

  it('nhãn thời gian đúng 25 fps', () => {
    expect(frameTimecode(0)).toBe('00:00');
    expect(frameTimecode(25)).toBe('00:01');
    expect(frameTimecode(1500)).toBe('01:00');
    expect(frameTimecode(1525)).toBe('01:01');
    expect(frameLabel(1500)).toBe('01:00 · frame 1500');
  });
});

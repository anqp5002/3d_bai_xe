import { beforeEach, describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import { createInitialStoreData, useSimStore } from './simStore';
import { freeSlotIds, setSpeedEvent } from './scenarioModel';
import { envPreset } from '../render/env/presets';
import { makeTestLot } from './testLot';

function setup(nParked = 1): LotMap {
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

beforeEach(() => {
  useSimStore.setState(createInitialStoreData());
});

describe('simStore — tạo map và chạy frame', () => {
  it('generateMap tạo scenario + state frame 0', () => {
    setup(2);
    const store = useSimStore.getState();
    expect(store.scenario).not.toBeNull();
    expect(store.scenario?.initial.n_parked).toBe(2);
    expect(store.state?.frame).toBe(0);
    expect(store.history).toHaveLength(1);
    expect(store.eventLog).toEqual([]);
    expect(store.error).toBeNull();
  });

  it('stepFrames tăng frame và history liên tiếp', () => {
    setup(1);
    useSimStore.getState().stepFrames(3);
    const store = useSimStore.getState();
    expect(store.state?.frame).toBe(3);
    expect(store.history.map((state) => state.frame)).toEqual([0, 1, 2, 3]);
  });

  it('seekTo chỉ tiến; lùi bị D9 chặn', () => {
    setup(1);
    useSimStore.getState().seekTo(5);
    expect(useSimStore.getState().state?.frame).toBe(5);
    useSimStore.getState().seekTo(2);
    expect(useSimStore.getState().state?.frame).toBe(5);
    expect(useSimStore.getState().error).toMatch(/D9/);
  });

  it('resetToZero quay về frame 0, giữ nhật ký', () => {
    setup(1);
    useSimStore.getState().stepFrames(4);
    useSimStore.getState().resetToZero();
    const store = useSimStore.getState();
    expect(store.state?.frame).toBe(0);
    expect(store.history).toHaveLength(1);
    expect(store.playing).toBe(false);
  });

  it('setCameraCount cập nhật cả scenario.camera_mode', () => {
    setup(1);
    useSimStore.getState().setCameraCount('1cam');
    expect(useSimStore.getState().cameraCount).toBe('1cam');
    expect(useSimStore.getState().scenario?.camera_mode).toBe('1cam');
  });
});

describe('simStore — sự kiện live', () => {
  it('addCarAt thêm xe vào ô trống và ghi nhật ký', () => {
    const lot = setup(1);
    const before = useSimStore.getState().state;
    expect(before).not.toBeNull();
    const free = freeSlotIds(lot, before as NonNullable<typeof before>);
    useSimStore.getState().addCarAt(free[0]);
    const after = useSimStore.getState();
    expect(after.eventLog).toHaveLength(1);
    expect(after.state?.frame).toBe(1);
    expect(after.state?.cars.length).toBe((before?.cars.length ?? 0) + 1);
    expect(after.state?.cars.map((car) => car.id)).toContain('V002');
    expect(after.error).toBeNull();
  });

  it('removeSelectedCar: xe đỗ sẵn rời đi', () => {
    setup(1);
    const parked = useSimStore.getState().state?.cars[0];
    expect(parked).toBeDefined();
    if (parked === undefined) {
      return;
    }
    useSimStore.getState().selectCar(parked.id);
    useSimStore.getState().removeSelectedCar();
    const after = useSimStore.getState();
    expect(after.eventLog).toHaveLength(1);
    expect(after.state?.frame).toBe(1);
    const updated = after.state?.cars.find((car) => car.id === parked.id);
    expect(updated?.state).not.toBe('parked');
    expect(['leaving_slot', 'driving_to_exit']).toContain(updated?.state);
  });

  it('setCarSpeed áp set_speed cho xe đang đỗ', () => {
    setup(1);
    const parked = useSimStore.getState().state?.cars[0];
    expect(parked).toBeDefined();
    if (parked === undefined) {
      return;
    }
    useSimStore.getState().selectCar(parked.id);
    useSimStore.getState().setCarSpeed(parked.id, 15);
    const updated = useSimStore
      .getState()
      .state?.cars.find((car) => car.id === parked.id);
    expect(updated?.desired_speed_mps).toBeCloseTo(15 / 3.6, 6);
    expect(useSimStore.getState().eventLog).toHaveLength(1);
  });

  it('D9: không thêm sự kiện khi đang trước sự kiện cuối', () => {
    setup(1);
    const store = useSimStore.getState();
    const scenario = store.scenario;
    expect(scenario).not.toBeNull();
    if (scenario === null) {
      return;
    }
    const future = setSpeedEvent(50, 'V001', 12);
    useSimStore.setState({
      eventLog: [future],
      scenario: { ...scenario, events: [future] },
    });
    useSimStore.getState().addCarAt();
    expect(useSimStore.getState().error).toMatch(/D9/);
    expect(useSimStore.getState().eventLog).toHaveLength(1);
  });

  it('setEnvPreset đổi env nhưng không đụng state/history/eventLog', () => {
    setup(1);
    const before = useSimStore.getState();
    useSimStore.getState().setEnvPreset('E8');
    const after = useSimStore.getState();
    expect(after.scenario?.env.preset).toBe('E8');
    expect(after.scenario?.env.keyframes).toEqual(envPreset('E8').keyframes);
    expect(after.state).toBe(before.state);
    expect(after.history).toBe(before.history);
    expect(after.eventLog).toBe(before.eventLog);
    expect(after.error).toBeNull();
  });

  it('setEnvPreset mã lạ → error, scenario không đổi', () => {
    setup(1);
    const beforeScenario = useSimStore.getState().scenario;
    useSimStore.getState().setEnvPreset('E9');
    expect(useSimStore.getState().error).toMatch(/E1–E8|không có/);
    expect(useSimStore.getState().scenario).toBe(beforeScenario);
  });

  it('setEnvKeyframe thêm/sửa/xoá, giữ t_s tăng dần và >= 1 mốc', () => {
    setup(1);
    const before = useSimStore.getState();
    const added = {
      t_s: 5,
      hour: 10,
      weather: 'cloud' as const,
      intensity: 0.5,
    };
    useSimStore.getState().setEnvKeyframe(-1, added);
    let store = useSimStore.getState();
    expect(store.scenario?.env.preset).toBeNull();
    expect(store.scenario?.env.keyframes.map((kf) => kf.t_s)).toEqual([0, 5]);
    expect(store.state).toBe(before.state);
    expect(store.history).toBe(before.history);
    expect(store.eventLog).toBe(before.eventLog);

    useSimStore.getState().setEnvKeyframe(0, {
      t_s: 7,
      hour: 11,
      weather: 'sun',
      intensity: 0.7,
    });
    store = useSimStore.getState();
    expect(store.scenario?.env.keyframes.map((kf) => kf.t_s)).toEqual([5, 7]);

    useSimStore.getState().setEnvKeyframe(0, null);
    store = useSimStore.getState();
    expect(store.scenario?.env.keyframes).toHaveLength(1);
    useSimStore.getState().setEnvKeyframe(0, null);
    expect(useSimStore.getState().error).toMatch(/ít nhất một mốc/);
    expect(useSimStore.getState().scenario?.env.keyframes).toHaveLength(1);
  });

  it('setEnvKeyframes bulk: sắp xếp/khử trùng, không đụng state/history/eventLog', () => {
    setup(1);
    const before = useSimStore.getState();
    useSimStore.getState().setEnvKeyframes([
      { t_s: 5, hour: 10, weather: 'cloud', intensity: 0.5 },
      { t_s: 1, hour: 8, weather: 'sun', intensity: 0.4 },
      { t_s: 5, hour: 11, weather: 'rain', intensity: 0.6 },
    ]);
    const after = useSimStore.getState();
    expect(after.scenario?.env.keyframes.map((kf) => kf.t_s)).toEqual([1, 5]);
    expect(after.scenario?.env.keyframes[1].hour).toBe(11);
    expect(after.scenario?.env.preset).toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.history).toBe(before.history);
    expect(after.eventLog).toBe(before.eventLog);
  });

  it('setEnvKeyframe trùng t_s: mốc mới thắng; index sai → error', () => {
    setup(1);
    useSimStore.getState().setEnvKeyframe(-1, {
      t_s: 0,
      hour: 6,
      weather: 'sun',
      intensity: 0.4,
    });
    const keyframes = useSimStore.getState().scenario?.env.keyframes ?? [];
    expect(keyframes).toHaveLength(1);
    expect(keyframes[0].hour).toBe(6);

    const beforeScenario = useSimStore.getState().scenario;
    useSimStore.getState().setEnvKeyframe(99, null);
    expect(useSimStore.getState().error).toMatch(/ngoài/);
    expect(useSimStore.getState().scenario).toBe(beforeScenario);
  });

  it('setEnvKeyframe hour sai → validateScenario chặn, scenario không đổi', () => {
    setup(1);
    const beforeScenario = useSimStore.getState().scenario;
    useSimStore.getState().setEnvKeyframe(-1, {
      t_s: 3,
      hour: 25,
      weather: 'sun',
      intensity: 0.5,
    });
    expect(useSimStore.getState().error).toMatch(/hour/);
    expect(useSimStore.getState().scenario).toBe(beforeScenario);
  });

  it('setNoiseToggle/setNoiseSeed đổi noise, không đụng state/history/eventLog', () => {
    setup(1);
    const before = useSimStore.getState();
    useSimStore.getState().setNoiseToggle('grain', { on: true, level: 0.8 });
    let store = useSimStore.getState();
    expect(store.scenario?.noise.grain).toEqual({ on: true, level: 0.8 });
    expect(store.state).toBe(before.state);
    expect(store.history).toBe(before.history);
    expect(store.eventLog).toBe(before.eventLog);

    useSimStore.getState().setNoiseSeed(123);
    store = useSimStore.getState();
    expect(store.scenario?.noise.seed).toBe(123);
    expect(store.state).toBe(before.state);

    useSimStore.getState().setNoiseToggle('grain', { on: true, level: 2 });
    expect(useSimStore.getState().error).toMatch(/level/);
    expect(useSimStore.getState().scenario?.noise.grain).toEqual({
      on: true,
      level: 0.8,
    });

    useSimStore.getState().setNoiseSeed(-1);
    expect(useSimStore.getState().error).toMatch(/seed/);
    expect(useSimStore.getState().scenario?.noise.seed).toBe(123);
  });

  it('selectSlot bận → chọn xe; ô trống → chọn ô', () => {
    const lot = setup(1);
    const parked = useSimStore.getState().state?.cars[0];
    expect(parked?.slot).toBeTruthy();
    if (parked === undefined || parked.slot === null) {
      return;
    }
    useSimStore.getState().selectSlot(parked.slot);
    expect(useSimStore.getState().selectedCarId).toBe(parked.id);

    const state = useSimStore.getState().state;
    expect(state).not.toBeNull();
    if (state === null) {
      return;
    }
    const free = freeSlotIds(lot, state);
    useSimStore.getState().selectSlot(free[0]);
    expect(useSimStore.getState().selectedCarId).toBeNull();
    expect(useSimStore.getState().selectedSlotId).toBe(free[0]);
  });
});

import { describe, expect, it } from 'vitest';
import { createDefaultScenario, validateScenario, ScenarioValidationError } from './scenario';

describe('contracts/scenario', () => {
  it('kịch bản mặc định hợp lệ và qua validate', () => {
    const scenario = createDefaultScenario(42);
    expect(validateScenario(scenario)).toEqual(scenario);
  });

  it('validate trả bản sao sâu, không dùng chung object với input', () => {
    const scenario = createDefaultScenario(7);
    const parsed = validateScenario(scenario);
    expect(parsed.env).not.toBe(scenario.env);
    expect(parsed.noise).not.toBe(scenario.noise);
  });

  it('từ chối schema khác 1', () => {
    const bad = { ...createDefaultScenario(), schema: 2 };
    expect(() => validateScenario(bad)).toThrow(/schema: phải bằng 1/);
  });

  it('từ chối hệ số xe ngoài 1,00–1,30 (C5)', () => {
    const bad = { ...createDefaultScenario(), car_scale: 1.5 };
    expect(() => validateScenario(bad)).toThrow(ScenarioValidationError);
    expect(() => validateScenario(bad)).toThrow(/car_scale/);
  });

  it('từ chối n_parked lệch số phần tử placement', () => {
    const base = createDefaultScenario();
    const bad = { ...base, initial: { n_parked: 2, placement: [] } };
    expect(() => validateScenario(bad)).toThrow(/initial\.placement/);
  });

  it('từ chối hai xe cùng ô hoặc trùng mã xe', () => {
    const base = createDefaultScenario();
    const sameSlot = {
      ...base,
      initial: {
        n_parked: 2,
        placement: [
          { slot: 'S001', car_id: 'V001', model: 'sedan', color: 'red' },
          { slot: 'S001', car_id: 'V002', model: 'suv', color: 'blue' },
        ],
      },
    };
    expect(() => validateScenario(sameSlot)).toThrow(/ô "S001" bị xếp hai xe/);
  });

  it('từ chối sự kiện lùi frame (D9)', () => {
    const base = createDefaultScenario();
    const bad = {
      ...base,
      events: [
        { frame: 50, type: 'leave_random', params: { n: 1 } },
        { frame: 20, type: 'leave_random', params: { n: 1 } },
      ],
    };
    expect(() => validateScenario(bad)).toThrow(/tăng dần/);
  });

  it('từ chối env.keyframes rỗng (interpolateEnv cần ≥ 1 mốc)', () => {
    const base = createDefaultScenario();
    const bad = { ...base, env: { preset: null, keyframes: [] } };
    expect(() => validateScenario(bad)).toThrow(/env\.keyframes/);
  });

  it('nhận mốc môi trường có wet/fog tuỳ chọn', () => {
    const base = createDefaultScenario();
    const withWet = {
      ...base,
      env: {
        preset: 'E4',
        keyframes: [{ t_s: 0, hour: 15, weather: 'rain', intensity: 0.5, wet: 0.9, fog: 0.2 }],
      },
    };
    const parsed = validateScenario(withWet);
    expect(parsed.env.keyframes[0]).toMatchObject({ wet: 0.9, fog: 0.2 });
  });
});

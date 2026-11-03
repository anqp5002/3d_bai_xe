import { describe, expect, it } from 'vitest';
import { createNoiseConfig, interpolateEnv, type EnvKeyframe, type NoiseKind } from './env';

describe('contracts/env', () => {
  it('có đủ 9 loại nhiễu, tất cả tắt mặc định (ý tưởng §10)', () => {
    const noise = createNoiseConfig(123);
    const kinds = Object.keys(noise).filter((key) => key !== 'seed');
    expect(kinds).toHaveLength(9);
    expect(kinds.sort()).toEqual(
      [
        'downscale',
        'drops',
        'flare',
        'fps_drop',
        'grain',
        'jpeg',
        'shake',
        'smudge',
        'white_balance',
      ].sort(),
    );
    for (const kind of kinds) {
      const toggle = noise[kind as NoiseKind];
      expect(toggle.on).toBe(false);
      expect(toggle.level).toBeGreaterThanOrEqual(0);
    }
    expect(noise.seed).toBe(123);
  });

  it('nội suy tuyến tính giữa hai mốc', () => {
    const keyframes: EnvKeyframe[] = [
      { t_s: 0, hour: 12, weather: 'sun', intensity: 0.2 },
      { t_s: 10, hour: 18, weather: 'cloud', intensity: 0.8 },
    ];
    const mid = interpolateEnv(keyframes, 5);
    expect(mid.hour).toBe(15);
    expect(mid.intensity).toBeCloseTo(0.5, 10);
    expect(mid.weather).toBe('sun');
    expect(mid.t_s).toBe(5);
  });

  it('ngoài biên thì kẹp về mốc đầu/cuối', () => {
    const keyframes: EnvKeyframe[] = [
      { t_s: 2, hour: 6, weather: 'fog', intensity: 0.9, wet: 0.4, fog: 0.8 },
      { t_s: 4, hour: 8, weather: 'sun', intensity: 0.1 },
    ];
    const before = interpolateEnv(keyframes, 0);
    expect(before.hour).toBe(6);
    expect(before.wet).toBe(0.4);
    const after = interpolateEnv(keyframes, 99);
    expect(after.hour).toBe(8);
    expect(after.fog).toBe(0);
  });

  it('mốc rỗng thì ném lỗi, không trả môi trường mặc định (R2)', () => {
    expect(() => interpolateEnv([], 0)).toThrow(/ít nhất một mốc/);
  });
});

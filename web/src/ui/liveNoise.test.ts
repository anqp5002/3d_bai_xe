/**
 * P14b — test cho lớp nhiễu camera của khung xem live.
 *
 * Trọng tâm: `applyLiveNoise` phải cho **ảnh khác** khi bật nhiễu và **giữ nguyên** khi tắt hết,
 * để khung xem giống video xuất mà không đổi gì khi kịch bản sạch.
 */

import { describe, expect, it } from 'vitest';
import type { NoiseConfig } from '../contracts/env';
import { NOISE_KINDS } from '../contracts/env';
import { applyLiveNoise, sunScreenPosition } from './liveNoise';
import type { RgbaFrame } from '../render/noise/cameraNoise';
import type { EnvApplyResult } from '../render/env/applyEnv';

function noiseOff(): NoiseConfig {
  const out: Record<string, unknown> = { seed: 1 };
  for (const kind of NOISE_KINDS) {
    out[kind] = { on: false, level: 0.5 };
  }
  return out as unknown as NoiseConfig;
}

function noiseOn(kind: (typeof NOISE_KINDS)[number], level = 1): NoiseConfig {
  const base = noiseOff() as unknown as Record<string, unknown>;
  base[kind] = { on: true, level };
  return base as unknown as NoiseConfig;
}

function flatImage(width: number, height: number, value = 128): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

describe('P14b liveNoise — bật/tắt nhiễu', () => {
  it('không bật loại nào thì trả null (không tốn putImageData)', () => {
    const image = flatImage(8, 8);
    expect(applyLiveNoise(image, noiseOff(), 0, null)).toBeNull();
  });

  it('bật grain thì trả ảnh khác ảnh gốc', () => {
    const image = flatImage(16, 16);
    const result = applyLiveNoise(image, noiseOn('grain'), 5, null);

    expect(result).not.toBeNull();
    expect(result!.applied).toBe(true);
    expect(result!.frame.width).toBe(16);
    expect(result!.frame.height).toBe(16);
    // Ít nhất một kênh phải khác giá trị phẳng ban đầu.
    let changed = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (
        result!.frame.data[index] !== image.data[index] ||
        result!.frame.data[index + 1] !== image.data[index + 1] ||
        result!.frame.data[index + 2] !== image.data[index + 2]
      ) {
        changed += 1;
      }
    }
    expect(changed, 'grain phải đổi ít nhất một pixel').toBeGreaterThan(0);
  });

  it('level 0 thì gần như không đổi (không tự bịa nhiễu)', () => {
    const image = flatImage(8, 8);
    const result = applyLiveNoise(image, noiseOn('grain', 0), 1, null);
    if (result === null) {
      return;
    }
    let changed = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (result.frame.data[index] !== image.data[index]) {
        changed += 1;
      }
    }
    expect(changed, 'level 0 không được tạo nhiễu đáng kể').toBeLessThan(8);
  });

  it('cùng frame + cùng seed thì tất định', () => {
    const image = flatImage(16, 16);
    const first = applyLiveNoise(image, noiseOn('grain'), 42, null);
    const second = applyLiveNoise(image, noiseOn('grain'), 42, null);

    expect(first!.frame.data).toEqual(second!.frame.data);
  });

  it('frame khác thì nhiễu khác (seed theo frame)', () => {
    const image = flatImage(16, 16);
    const a = applyLiveNoise(image, noiseOn('grain'), 1, null);
    const b = applyLiveNoise(image, noiseOn('grain'), 2, null);

    expect(a!.frame.data).not.toEqual(b!.frame.data);
  });

  it('ảnh gốc KHÔNG bị sửa tại chỗ (hàm thuần)', () => {
    const image = flatImage(8, 8, 100);
    const before = new Uint8ClampedArray(image.data);
    applyLiveNoise(image, noiseOn('grain'), 3, null);
    expect(image.data).toEqual(before);
  });
});

describe('P14b liveNoise — vị trí mặt trời', () => {
  function env(overrides: Partial<EnvApplyResult> = {}): EnvApplyResult {
    return {
      sun: {
        elevationDeg: 45,
        azimuthDeg: 135,
        belowHorizon: false,
        intensity: 0.8,
        colorHex: '#ffffff',
        position: [0, 0, 50],
      },
      darkness: 0.1,
      lampsOn: false,
      rainIntensity: 0,
      wetness: 0,
      fogDensity: 0,
      cloudCover: 0.2,
      ...overrides,
    } as EnvApplyResult;
  }

  it('trả null khi không có env', () => {
    expect(sunScreenPosition(null)).toBeNull();
  });

  it('trả null khi mặt trời dưới chân trời', () => {
    const value = env();
    const patched = { ...value, sun: { ...value.sun, belowHorizon: true } } as EnvApplyResult;
    expect(sunScreenPosition(patched)).toBeNull();
  });

  it('trả null khi trời đã tối hẳn (darkness > 0,9)', () => {
    expect(sunScreenPosition(env({ darkness: 0.95 }))).toBeNull();
  });

  it('công thức khớp export: u = 320 + (azimuth − 90)·2, v = 200 − elevation·1,2', () => {
    const result = sunScreenPosition(env());
    expect(result).not.toBeNull();
    expect(result!.u).toBeCloseTo(320 + (135 - 90) * 2.0, 6);
    expect(result!.v).toBeCloseTo(200 - 45 * 1.2, 6);
    expect(result!.intensity).toBeCloseTo(0.8, 6);
  });

  it('cường độ bị kẹp ≤ 1', () => {
    const value = env();
    const patched = { ...value, sun: { ...value.sun, intensity: 1.7 } } as EnvApplyResult;
    expect(sunScreenPosition(patched)!.intensity).toBe(1);
  });
});

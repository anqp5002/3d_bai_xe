/**
 * Test mô hình mặt trời + 8 kịch bản E1–E8 (P8 mục 1–2).
 */

import { describe, expect, it } from 'vitest';
import {
  LIGHTS_ON_HOUR,
  SUN_MAX_ELEVATION_DEG,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  darknessAt,
  sunAzimuthDeg,
  sunColorHex,
  sunElevationDeg,
  sunState,
  wrapHour,
} from './sun';
import { ENV_PRESETS, envPreset, presetCheckpoints } from './presets';
import { interpolateEnv } from '../../contracts/env';

describe('render/env/sun — quỹ đạo mặt trời', () => {
  it('mọc 6h, đỉnh 75° lúc 12h, lặn 18h (FE §6)', () => {
    expect(sunElevationDeg(SUNRISE_HOUR)).toBeCloseTo(0, 6);
    expect(sunElevationDeg(12)).toBeCloseTo(SUN_MAX_ELEVATION_DEG, 6);
    expect(sunElevationDeg(SUNSET_HOUR)).toBeCloseTo(0, 6);
  });

  it('ban đêm âm, nửa đêm −75° (đối xứng)', () => {
    expect(sunElevationDeg(0)).toBeCloseTo(-SUN_MAX_ELEVATION_DEG, 6);
    expect(sunElevationDeg(21)).toBeLessThan(0);
    expect(sunElevationDeg(3)).toBeLessThan(0);
  });

  it('đối xứng quanh 12h: 9h và 15h cùng độ cao', () => {
    expect(sunElevationDeg(9)).toBeCloseTo(sunElevationDeg(15), 9);
    expect(sunElevationDeg(7)).toBeCloseTo(sunElevationDeg(17), 9);
  });

  it('phương vị: 6h = đông (0°), 12h = bắc (90°), 18h = tây (180°)', () => {
    expect(sunAzimuthDeg(6)).toBeCloseTo(0, 6);
    expect(sunAzimuthDeg(12)).toBeCloseTo(90, 6);
    expect(sunAzimuthDeg(18)).toBeCloseTo(180, 6);
  });

  it('wrapHour chuẩn hoá về [0, 24) và từ chối NaN', () => {
    expect(wrapHour(25)).toBeCloseTo(1, 9);
    expect(wrapHour(-1)).toBeCloseTo(23, 9);
    expect(wrapHour(48)).toBeCloseTo(0, 9);
    expect(() => wrapHour(Number.NaN)).toThrow(/hữu hạn/);
  });

  it('màu nắng ấm khi thấp, trắng khi cao (FE §6)', () => {
    const low = sunColorHex(2);
    const high = sunColorHex(70);
    // Kênh xanh dương tăng khi mặt trời lên cao (ấm → trắng).
    const blue = (hex: string): number => parseInt(hex.slice(5, 7), 16);
    expect(blue(low)).toBeLessThan(blue(high));
    expect(low).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('sunState trả vị trí, cường độ, cờ đèn đúng', () => {
    const noon = sunState(12);
    expect(noon.belowHorizon).toBe(false);
    expect(noon.intensity).toBeCloseTo(1, 6);
    expect(noon.lampsOn).toBe(false);
    expect(noon.position[2]).toBeGreaterThan(100);

    const night = sunState(22);
    expect(night.belowHorizon).toBe(true);
    expect(night.intensity).toBe(0);
    expect(night.lampsOn).toBe(true);
  });

  it('đèn bật từ 18h15 (E5) hoặc khi mưa to (FE §6)', () => {
    expect(sunState(18.2).lampsOn).toBe(false);
    expect(sunState(LIGHTS_ON_HOUR).lampsOn).toBe(true);
    // 15h nắng: đèn tắt.
    expect(sunState(15, 0).lampsOn).toBe(false);
    // 15h mưa to: đèn bật.
    expect(sunState(15, 0.8).lampsOn).toBe(true);
  });

  it('darknessAt: 0 ban ngày, 1 ban đêm, tăng dần khi hoàng hôn', () => {
    expect(darknessAt(12)).toBe(0);
    expect(darknessAt(22)).toBe(1);
    const dusk = [16, 17, 18, 19].map((hour) => darknessAt(hour));
    for (let index = 1; index < dusk.length; index += 1) {
      expect(dusk[index]).toBeGreaterThanOrEqual(dusk[index - 1]);
    }
  });
});

describe('render/env/presets — 8 kịch bản E1–E8', () => {
  it('đủ 8 kịch bản, đúng thứ tự và mã', () => {
    expect(ENV_PRESETS).toHaveLength(8);
    expect(ENV_PRESETS.map((preset) => preset.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8',
    ]);
  });

  it('mỗi kịch bản có ≥ 1 mốc, mốc tăng dần theo t_s', () => {
    for (const preset of ENV_PRESETS) {
      expect(preset.keyframes.length).toBeGreaterThanOrEqual(1);
      for (let index = 1; index < preset.keyframes.length; index += 1) {
        expect(preset.keyframes[index].t_s).toBeGreaterThan(preset.keyframes[index - 1].t_s);
      }
      expect(preset.duration_s).toBeGreaterThan(0);
    }
  });

  it('E1 là trưa nắng cố định 12h', () => {
    const e1 = envPreset('E1');
    expect(e1.keyframes).toHaveLength(1);
    expect(e1.keyframes[0].hour).toBe(12);
    expect(e1.keyframes[0].weather).toBe('sun');
  });

  it('E2 chạy 6h → 18h (ngày nắng, bóng xoay)', () => {
    const e2 = envPreset('E2');
    expect(e2.keyframes[0].hour).toBe(6);
    expect(e2.keyframes[e2.keyframes.length - 1].hour).toBe(18);
    expect(e2.duration_s).toBeGreaterThanOrEqual(30);
  });

  it('E3 trời mây 10h', () => {
    const e3 = envPreset('E3');
    expect(e3.keyframes[0].hour).toBe(10);
    expect(e3.keyframes[0].weather).toBe('cloud');
  });

  it('E4 mưa chiều: nắng → mây → mưa vừa → mưa to → tạnh còn ướt', () => {
    const e4 = envPreset('E4');
    const weathers = e4.keyframes.map((keyframe) => keyframe.weather);
    expect(weathers[0]).toBe('sun');
    expect(weathers).toContain('cloud');
    expect(weathers).toContain('rain');
    const rainLevels = e4.keyframes
      .filter((keyframe) => keyframe.weather === 'rain')
      .map((keyframe) => keyframe.intensity);
    expect(Math.max(...rainLevels)).toBeGreaterThan(0.6);
    // Tạnh nhưng đường còn ướt.
    const last = e4.keyframes[e4.keyframes.length - 1];
    expect(last.weather).toBe('cloud');
    expect(last.wet ?? 0).toBeGreaterThan(0.5);
  });

  it('E5 chạng vạng 17h → 19h30, có mốc qua 18h15', () => {
    const e5 = envPreset('E5');
    expect(e5.keyframes[0].hour).toBe(17);
    expect(e5.keyframes[e5.keyframes.length - 1].hour).toBe(19.5);
    const hasNightLights = e5.keyframes.some((keyframe) => keyframe.hour >= LIGHTS_ON_HOUR);
    expect(hasNightLights).toBe(true);
  });

  it('E6 đêm 22h, E8 đêm mưa 21h', () => {
    expect(envPreset('E6').keyframes[0].hour).toBe(22);
    const e8 = envPreset('E8');
    expect(e8.keyframes[0].hour).toBe(21);
    expect(e8.keyframes[0].weather).toBe('rain');
    expect(e8.keyframes[0].wet ?? 0).toBeGreaterThan(0.8);
  });

  it('E7 sương sớm 5h30 → 8h, sương giảm dần', () => {
    const e7 = envPreset('E7');
    expect(e7.keyframes[0].hour).toBe(5.5);
    expect(e7.keyframes[e7.keyframes.length - 1].hour).toBe(8);
    const fogs = e7.keyframes.map((keyframe) => keyframe.fog ?? 0);
    for (let index = 1; index < fogs.length; index += 1) {
      expect(fogs[index]).toBeLessThan(fogs[index - 1]);
    }
  });

  it('mọi mốc hợp lệ: hour 0–24, intensity 0–1, wet/fog 0–1', () => {
    for (const preset of ENV_PRESETS) {
      for (const keyframe of preset.keyframes) {
        expect(keyframe.hour).toBeGreaterThanOrEqual(0);
        expect(keyframe.hour).toBeLessThanOrEqual(24);
        expect(keyframe.intensity).toBeGreaterThanOrEqual(0);
        expect(keyframe.intensity).toBeLessThanOrEqual(1);
        if (keyframe.wet !== undefined) {
          expect(keyframe.wet).toBeGreaterThanOrEqual(0);
          expect(keyframe.wet).toBeLessThanOrEqual(1);
        }
        if (keyframe.fog !== undefined) {
          expect(keyframe.fog).toBeGreaterThanOrEqual(0);
          expect(keyframe.fog).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('envPreset mã lạ thì ném lỗi (R2)', () => {
    expect(() => envPreset('E9')).toThrow(/E1–E8/);
    expect(() => envPreset('')).toThrow(/E1–E8/);
  });

  it('presetCheckpoints trả mốc đầu và cuối để chụp ảnh', () => {
    expect(presetCheckpoints(envPreset('E1'))).toEqual([0]);
    expect(presetCheckpoints(envPreset('E2'))).toEqual([0, 40]);
    expect(presetCheckpoints(envPreset('E4'))).toEqual([0, 30]);
  });

  it('nội suy E2 giữa hai mốc cho giờ trung gian (hợp đồng P1)', () => {
    const e2 = envPreset('E2');
    const mid = interpolateEnv(e2.keyframes, 15);
    expect(mid.hour).toBeCloseTo(10.5, 6);
    expect(mid.weather).toBe('sun');
  });

  it('nội suy E4 qua mốc mưa: intensity tăng, weather chuyển sang rain', () => {
    const e4 = envPreset('E4');
    const before = interpolateEnv(e4.keyframes, 8);
    const during = interpolateEnv(e4.keyframes, 14);
    expect(before.weather).toBe('cloud');
    expect(during.weather).toBe('rain');
    expect(during.intensity).toBeGreaterThan(before.intensity);
  });
});
